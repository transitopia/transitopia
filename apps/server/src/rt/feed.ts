// One feed's GTFS-realtime on the leader (apps/server/README.md#real-time-service): polls its positions,
// trip updates and alerts on the feed's schedule within its daily cap (config/feeds/<feed>/feed.json →
// realtime.poll, packages/transit-core/src/rt/budget.ts), records every route, keeps the service
// changes, and serves what the live endpoint, /rt/history and /rt/status need. RtService runs one per
// feed, whichever regions show it, so a feed in two regions is polled and recorded once.

import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type {
  FeedInfo,
  FeedRealtime,
} from "@transitopia/transit-core/config.ts";
import type {
  FeedManifest,
  ServicePlan,
} from "@transitopia/transit-core/plan/types.ts";
import {
  compactSnapshot,
  decodeSnapshot,
  encodeSnapshot,
  isTracked,
  trackedOnly,
  untrackedRouteKey,
  type RtLiveResponse,
  type RtSnapshot,
  type RtVehicle,
} from "@transitopia/transit-core/rt/types.ts";
import type {
  LiveChangesSection,
  LiveVehiclesSection,
  VersionPointer,
} from "@transitopia/transit-core/rt/live.ts";
import type { RtRouteAlert } from "@transitopia/transit-core/rt/changes.ts";
import {
  cadence,
  pollIntervalS,
  POLL_FEEDS,
  RequestLedger,
  type Cadence,
  type PollFeed,
} from "@transitopia/transit-core/rt/budget.ts";
import {
  addDays,
  localDate,
  isServiceDate,
} from "@transitopia/transit-core/time.ts";
import { PUBLIC_DIR, feedPaths } from "@transitopia/data/paths.ts";
import type { ProviderStatus } from "@transitopia/shared/admin-api.ts";
import { Recorder } from "./recorder.ts";
import { ServiceChanges } from "./changes.ts";
import type { Store } from "../store.ts";
import {
  delayFor,
  fetchAlerts,
  fetchPositions,
  fetchTripUpdates,
  tripFeedSummary,
  type DecodedAlert,
  type TripDelays,
  type TripFeedSummary,
  type Upstream,
} from "./upstream.ts";

/** Closed history hours kept filtered in memory for /rt/history. */
const HISTORY_CACHE_HOURS = 48;

export interface FeedPollerOptions {
  feed: FeedInfo & { realtime: FeedRealtime };
  /** Its key, when the feed needs one (realtime.apiKey). */
  apiKey: string | undefined;
  /** Poll upstream at all (RT_POLL). Without it, the last recording is served and nothing is fetched. */
  poll: boolean;
  /** Where the feed's recordings go (var/rt-history/<feed>/). */
  historyDir: string;
  record: boolean;
  store: Store | undefined;
  /** Every alerts poll, with the feed's SkyTrain lines by GTFS route_id (alert drafts, RtService). */
  onAlerts?:
    | ((
        alerts: DecodedAlert[],
        railKeyById: Map<string, string>,
      ) => Promise<void>)
    | undefined;
  log: (msg: string) => void;
}

export class FeedPoller {
  readonly feed: FeedInfo & { realtime: FeedRealtime };
  readonly recorder: Recorder;
  readonly changes: ServiceChanges;
  readonly cadence: Cadence;
  private readonly upstream: Upstream;
  private readonly opts: FeedPollerOptions;
  private latest: RtSnapshot | null = null;
  private delays: TripDelays = new Map();
  private routeKeyById = new Map<string, string>();
  /** GTFS route_id → our key for SkyTrain lines (alerts). */
  private railKeyById = new Map<string, string>();
  private routesLoadedFrom: number | undefined;
  /** Each endpoint's pending poll (one per endpoint: a tick schedules the next). */
  private timers: Partial<Record<PollFeed, ReturnType<typeof setTimeout>>> = {};
  private running = false;
  /** Per endpoint: when it last polled successfully and its last error, so one's success can't hide another's failure. */
  private endpoints: Record<
    PollFeed,
    { lastOkAt?: number; lastError?: string }
  > = { positions: {}, tripUpdates: {}, alerts: {} };
  /** Share of the latest poll's vehicles on a trip that have a delay (null before a poll). */
  private delayCoverage: number | null = null;
  /** Trip id → route id of every bus on a trip in the latest positions poll (every route). */
  private busTrips = new Map<string, string | undefined>();
  /** The latest trip-updates poll, matched against busTrips (/rt/status → tripFeed). */
  private tripFeed: TripFeedSummary | null = null;
  private consecutiveErrors: Record<PollFeed, number> = {
    positions: 0,
    tripUpdates: 0,
    alerts: 0,
  };
  upstreamCalls = 0;
  private ledger: RequestLedger;
  private ledgerWrite: Promise<void> = Promise.resolve();
  private nextPollAt: Partial<Record<PollFeed, number>> = {};
  private capped = false;
  /** When this process started polling as the leader (endpoints' ages count from here until their first success). */
  private pollingSince: number | undefined;
  private historyCache = new Map<string, Buffer>();

  constructor(opts: FeedPollerOptions) {
    this.opts = opts;
    this.feed = opts.feed;
    this.cadence = cadence(opts.feed.realtime);
    this.upstream = {
      name: opts.feed.name,
      rt: opts.feed.realtime,
      apiKey: opts.apiKey,
    };
    this.recorder = new Recorder(opts.historyDir, (t) =>
      this.cadence.coverageGapMs(t),
    );
    this.changes = new ServiceChanges(
      join(opts.historyDir, "changes"),
      opts.record,
    );
    this.ledger = new RequestLedger(this.schedule.dailyCap);
  }

  private get schedule() {
    return this.feed.realtime.poll;
  }

  private log(msg: string): void {
    this.opts.log(`${this.feed.id}: ${msg}`);
  }

  /** Whether it has the key it needs (keyless feeds always do). */
  get hasKey(): boolean {
    return this.feed.realtime.apiKey === undefined || Boolean(this.opts.apiKey);
  }

  /** Whether it fetches upstream (RT_POLL, and its key if it needs one). */
  get polling(): boolean {
    return this.opts.poll && this.hasKey;
  }

  /** Why its vehicles are unavailable, if they are for a reason other than a failing poll. */
  private get unavailableReason(): string | undefined {
    if (!this.opts.poll) return `Not polling ${this.feed.name} here`;
    if (!this.hasKey) return `No ${this.feed.name} API key configured`;
    return undefined;
  }

  /** Start polling (the leader only). Serves the last recorded snapshot until the first poll. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.loadRoutes();
    if (!this.polling) {
      if (this.opts.poll)
        this.log(
          `no ${this.feed.realtime.apiKey} (env or .secrets): real-time buses disabled, schedule estimates only.`,
        );
      return;
    }
    await this.recorder.init();
    await this.loadLedger();
    if (this.opts.record) {
      const last = await this.recorder.lastSnapshot();
      this.latest = last ? trackedOnly(last) : null;
    }
    const now = Date.now();
    const s = this.schedule;
    this.log(
      `polling ${this.feed.name} on a schedule (now every ${pollIntervalS(s, "positions", now)}s positions, `
        + `${pollIntervalS(s, "tripUpdates", now)}s trip updates, ${pollIntervalS(s, "alerts", now)}s alerts; `
        + `${this.ledger.count(now)}/${s.dailyCap} requests used in the last 24 h); recording to ${this.recorder.dir}`,
    );
    this.pollingSince = Date.now();
    this.loop("tripUpdates", () => this.pollTripUpdates());
    this.loop("positions", () => this.pollPositions());
    this.loop("alerts", () => this.pollAlerts());
  }

  stop(): void {
    this.running = false;
    for (const t of Object.values(this.timers)) clearTimeout(t);
    this.timers = {};
  }

  // --- the request ledger ---

  private get ledgerPath(): string {
    return join(this.recorder.dir, "requests.json");
  }

  private async loadLedger(): Promise<void> {
    const cap = this.schedule.dailyCap;
    if (this.opts.store) {
      this.ledger = new RequestLedger(
        cap,
        await this.opts.store.recentRequests(this.feed.id),
      );
      return;
    }
    try {
      const raw = JSON.parse(await readFile(this.ledgerPath, "utf8")) as {
        requests?: [number, PollFeed][];
      };
      this.ledger = new RequestLedger(cap, raw.requests ?? []);
    } catch {
      // No ledger yet (first run, or a history dir without one).
    }
  }

  /** Persist the ledger (serialised, atomic), so restarts keep counting. With a database, requests are rows instead. */
  private saveLedger(): Promise<void> {
    if (this.opts.store) return Promise.resolve();
    const text = JSON.stringify(this.ledger);
    this.ledgerWrite = this.ledgerWrite
      .then(async () => {
        const tmp = `${this.ledgerPath}.tmp`;
        await writeFile(tmp, text);
        await rename(tmp, this.ledgerPath);
      })
      .catch((e) =>
        this.log(
          `could not save request ledger (${e instanceof Error ? e.message : String(e)})`,
        ),
      );
    return this.ledgerWrite;
  }

  /**
   * Poll `endpoint` on the schedule: at its current interval, backing off on consecutive errors,
   * and never beyond the daily cap (every attempt counts, failed or not). The first poll continues
   * the schedule from the last recorded request, so a restart doesn't poll everything at once.
   */
  private loop(
    endpoint: PollFeed,
    /** Resolves to the response size (bytes), where known. */
    fn: () => Promise<number | void>,
  ): void {
    const s = this.schedule;
    const schedule = (at: number) => {
      this.nextPollAt[endpoint] = at;
      clearTimeout(this.timers[endpoint]);
      if (this.running)
        this.timers[endpoint] = setTimeout(tick, Math.max(0, at - Date.now()));
    };
    const record = (r: {
      ts: number;
      status?: number;
      bytes?: number | undefined;
      error?: string;
    }) =>
      void this.opts.store
        ?.recordRequest({ provider: this.feed.id, feed: endpoint, ...r })
        .catch((e: Error) =>
          this.log(`could not record request (${e.message})`),
        );
    const tick = async () => {
      if (!this.running) return;
      const now = Date.now();
      const allowedAt = this.ledger.nextAllowedAt(now);
      if (allowedAt > now) {
        if (!this.capped)
          this.log(
            `daily cap of ${s.dailyCap} requests reached; pausing until ${new Date(allowedAt).toISOString()}`,
          );
        this.capped = true;
        schedule(allowedAt);
        return;
      }
      this.capped = false;
      this.ledger.record(endpoint, now);
      this.upstreamCalls++;
      void this.saveLedger();
      let delay = pollIntervalS(s, endpoint, now) * 1000;
      try {
        const bytes = await fn();
        this.consecutiveErrors[endpoint] = 0;
        this.endpoints[endpoint] = { lastOkAt: now };
        record({
          ts: now,
          status: 200,
          bytes: typeof bytes === "number" ? bytes : undefined,
        });
      } catch (e) {
        const n = ++this.consecutiveErrors[endpoint];
        const error = e instanceof Error ? e.message : String(e);
        this.endpoints[endpoint] = {
          ...this.endpoints[endpoint],
          lastError: error,
        };
        record({ ts: now, error });
        delay = Math.min(Math.max(300_000, delay), delay * 2 ** Math.min(4, n));
        this.log(
          `${endpoint} poll failed (${error}); retrying in ${Math.round(delay / 1000)}s`,
        );
      }
      schedule(now + delay);
    };
    const last = this.ledger.lastAt(endpoint);
    schedule(
      last === undefined ?
        Date.now()
      : last + pollIntervalS(s, endpoint, last) * 1000,
    );
  }

  /**
   * GTFS route_id → our route key, from every built version of the feed (route IDs can differ between
   * versions). Reloaded whenever the feed's manifest changes, so routes added to its routes.json (and
   * rebuilt with `npm run data`) are picked up without restarting.
   */
  private async loadRoutes(): Promise<void> {
    try {
      const manifestPath = feedPaths(this.feed.id).manifest;
      const mtime = (await stat(manifestPath)).mtimeMs;
      if (mtime === this.routesLoadedFrom) return;
      const manifest = JSON.parse(
        await readFile(manifestPath, "utf8"),
      ) as FeedManifest;
      const map = new Map<string, string>();
      const rail = new Map<string, string>();
      for (const f of manifest.feeds) {
        const plan = JSON.parse(
          await readFile(join(PUBLIC_DIR, f.path), "utf8"),
        ) as Pick<ServicePlan, "routes">;
        for (const r of plan.routes) {
          if (r.kind === "bus") map.set(r.gtfsRouteId, r.key);
          if (r.kind === "skytrain") rail.set(r.gtfsRouteId, r.key);
        }
      }
      if (this.routesLoadedFrom !== undefined)
        this.log(
          `timetable data changed: now tracking ${[...new Set(map.values())].join(", ")}`,
        );
      this.routeKeyById = map;
      this.railKeyById = rail;
      this.routesLoadedFrom = mtime;
    } catch (e) {
      this.log(
        `could not read the timetable manifest (${e instanceof Error ? e.message : String(e)}); run "npm run data:gtfs".`,
      );
    }
  }

  // --- polls ---

  private async pollAlerts(): Promise<void> {
    const decoded = await fetchAlerts(this.upstream);
    await this.opts.store?.recordAlerts(this.feed.id, decoded);
    await this.opts.onAlerts?.(decoded, this.railKeyById);
    // Bus route alerts (e.g. detours), kept per day for playback.
    const bus: Omit<RtRouteAlert, "seen">[] = [];
    for (const a of decoded) {
      const entities = a.entities.flatMap(({ routeId, ...rest }) => {
        const routeKey = this.routeKeyById.get(routeId);
        return routeKey ? [{ routeKey, ...rest }] : [];
      });
      if (!entities.length) continue;
      bus.push({
        id: a.id,
        entities,
        stopIds: a.stopIds,
        periods: a.periods,
        ...(a.effect !== undefined ? { effect: a.effect } : {}),
        header: a.header,
        description: a.description,
      });
    }
    await this.changes.updateAlerts(bus);
  }

  private async pollTripUpdates(): Promise<number> {
    const { delays, changes, trips, headerTs, bytes } = await fetchTripUpdates(
      this.upstream,
      AbortSignal.timeout(15_000),
    );
    this.delays = delays;
    this.reportTripFeed(
      tripFeedSummary({ trips, headerTs, bytes }, this.busTrips, Date.now()),
    );
    const today = localDate(Date.now());
    const rows = changes.map((c) => ({
      tripId: c.tripId,
      routeId: c.routeId,
      date: c.startDate && isServiceDate(c.startDate) ? c.startDate : today,
      cancelled: c.cancelled,
      skippedStopIds: c.skippedStopIds,
    }));
    await this.opts.store?.recordTripChanges(this.feed.id, rows);
    await this.changes.updateTrips(
      rows.filter((c) => c.routeId && this.routeKeyById.has(c.routeId)),
    );
    return bytes;
  }

  /**
   * Keeps the latest trip-updates summary, and logs it while few buses' trips are in the feed (and
   * once when that recovers), so an empty feed and trip ids that no longer match tell themselves apart.
   */
  private reportTripFeed(t: TripFeedSummary): void {
    const wasLow = this.tripFeed !== null && this.tripFeedLow(this.tripFeed);
    this.tripFeed = t;
    const low = this.tripFeedLow(t);
    if (!low && !wasLow) return;
    const age =
      t.headerAgeS === null ? "no timestamp" : `${t.headerAgeS} s old`;
    const sample = (a: { tripId: string; routeId?: string }[]) =>
      a.map((x) => `${x.tripId} (route ${x.routeId ?? "?"})`).join(", ")
      || "none";
    this.log(
      low ?
        `trip updates match few buses: ${t.busesMatched} of ${t.busesOnTrips} buses' trips are in the feed; feed has ${t.trips} trips (${t.withStopDelays} with stop delays, ${t.matched} matched), ${Math.round(t.bytes / 1024)} KB, ${age}. Unmatched feed trips: ${sample(t.unmatchedTrips)}. Unmatched bus trips: ${sample(t.unmatchedBuses)}`
      : `trip updates match buses again: ${t.busesMatched} of ${t.busesOnTrips}`,
    );
  }

  private tripFeedLow(t: TripFeedSummary): boolean {
    return (
      t.busesOnTrips > 0
      && t.busesMatched / t.busesOnTrips
        < this.feed.realtime.tripUpdatesMinCoverage
    );
  }

  private async pollPositions(): Promise<number> {
    await this.loadRoutes();
    const fetchedAt = Date.now();
    const decoded = await fetchPositions(
      this.upstream,
      AbortSignal.timeout(15_000),
    );
    const vehicles: RtVehicle[] = [];
    let onTrips = 0;
    let withDelay = 0;
    const busTrips = new Map<string, string | undefined>();
    for (const p of decoded.positions) {
      const routeKey =
        (p.routeId ? this.routeKeyById.get(p.routeId) : undefined)
        ?? untrackedRouteKey(p.routeId);
      const v: RtVehicle = {
        id: p.vehicleId,
        routeKey,
        lat: p.lat,
        lon: p.lon,
        ts: p.ts ?? decoded.headerTs,
      };
      if (p.label) v.label = p.label;
      if (p.tripId) v.tripId = p.tripId;
      if (p.bearing !== undefined) v.bearing = p.bearing;
      if (p.stopSeq !== undefined) v.stopSeq = p.stopSeq;
      if (p.stopId) v.stopId = p.stopId;
      if (p.status !== undefined) v.status = p.status;
      const delay = delayFor(this.delays, p.tripId, p.stopSeq);
      if (delay !== undefined) v.delay = delay;
      if (p.tripId) {
        busTrips.set(p.tripId, p.routeId);
        onTrips++;
        if (delay !== undefined) withDelay++;
      }
      vehicles.push(v);
    }
    const all: RtSnapshot = { fetchedAt, headerTs: decoded.headerTs, vehicles };
    this.latest = trackedOnly(all);
    this.busTrips = busTrips;
    // Not before trip updates have been read at all (positions may come back first after a start).
    this.delayCoverage =
      onTrips && this.endpoints.tripUpdates.lastOkAt !== undefined ?
        withDelay / onTrips
      : null;
    if (this.opts.record) await this.recorder.record(all);
    await this.opts.store?.recordPositions(
      this.feed.id,
      fetchedAt,
      decoded.headerTs,
      decoded.positions.map((p, i) => ({
        ...p,
        id: p.vehicleId,
        routeKey: isTracked(vehicles[i]!) ? vehicles[i]!.routeKey : undefined,
        ts: vehicles[i]!.ts,
        delay: vehicles[i]!.delay,
      })),
    );
    return decoded.bytes;
  }

  // --- what clients get ---

  /** The latest snapshot of the routes we draw (GET /rt/live, before the live endpoint). */
  liveResponse(now = Date.now()): RtLiveResponse {
    const ageS = this.latest ? (now - this.latest.fetchedAt) / 1000 : null;
    const r: RtLiveResponse = {
      snapshot: this.latest,
      ageS,
      stale:
        ageS === null
        || !this.latest
        || ageS * 1000 > this.cadence.staleAfterMs(this.latest.fetchedAt),
    };
    const reason = this.unavailableReason;
    if (reason) r.error = reason;
    else if (this.endpoints.positions.lastError && r.stale)
      r.error = this.endpoints.positions.lastError;
    return r;
  }

  /** Its sections of a region's live endpoint: "<feed>/vehicles" and "<feed>/changes". */
  async liveSections(
    regionId: string,
    now = Date.now(),
  ): Promise<Record<string, LiveVehiclesSection | LiveChangesSection>> {
    const live = this.liveResponse(now);
    const vehicles: LiveVehiclesSection = {
      kind: "vehicles",
      encoding: "rt-snapshot/1",
      status:
        !this.latest ? "unavailable"
        : live.stale ? "stale"
        : "ok",
      // A stale snapshot isn't shown (schedule estimates are), so it isn't sent.
      data: this.latest && !live.stale ? compactSnapshot(this.latest) : null,
    };
    if (live.error) vehicles.error = live.error;
    // Service changes for the dates the live view shows: today's and yesterday's (after midnight).
    const versions: Record<string, VersionPointer> = {};
    const today = localDate(now);
    for (const date of [addDays(today, -1), today]) {
      const { version } = await this.changes.versioned(date);
      versions[date] = {
        version,
        path: `regions/${regionId}/days/${date}/${this.feed.id}/changes/${version}.json`,
      };
    }
    return {
      [`${this.feed.id}/vehicles`]: vehicles,
      [`${this.feed.id}/changes`]: { kind: "changes", versions },
    };
  }

  /** When its next upstream poll is due, if it polls. */
  nextDataAt(): number | undefined {
    if (!this.polling) return undefined;
    const due = Object.values(this.nextPollAt);
    return due.length ? Math.min(...due) : undefined;
  }

  /** Recorder coverage intervals (GET /rt/coverage). */
  coverage(from: number, to: number): [number, number][] {
    return this.recorder.coverage(from, to);
  }

  /**
   * A recorded hour with only the routes we draw, gzipped (GET /rt/history). The files hold every
   * route; closed hours are filtered once and kept for a while.
   */
  async trackedHour(
    date: string,
    hour: string,
  ): Promise<{ body: Buffer; closed: boolean } | undefined> {
    const f = await this.recorder.hourFile(date, hour);
    if (!f) return undefined;
    const hit = this.historyCache.get(f.path);
    if (hit) return { body: hit, closed: true };
    const buf = await readFile(f.path);
    const lines: string[] = [];
    for (const line of (f.gzip ? gunzipSync(buf) : buf)
      .toString("utf8")
      .split("\n")) {
      if (!line) continue;
      try {
        lines.push(encodeSnapshot(trackedOnly(decodeSnapshot(line))));
      } catch {
        // The open hour's last line may be half written.
      }
    }
    const out = gzipSync(lines.length ? `${lines.join("\n")}\n` : "");
    if (f.gzip) {
      this.historyCache.set(f.path, out);
      while (this.historyCache.size > HISTORY_CACHE_HOURS)
        this.historyCache.delete(this.historyCache.keys().next().value!);
    }
    return { body: out, closed: f.gzip };
  }

  /** Requests used against the daily cap, and when each endpoint polls next. */
  budgetStatus(now = Date.now()): ProviderStatus["budget"] {
    const s = this.schedule;
    const intervalsS = Object.fromEntries(
      POLL_FEEDS.map((f) => [f, pollIntervalS(s, f, now)]),
    );
    const nextPollInS = Object.fromEntries(
      Object.entries(this.nextPollAt).map(([f, at]) => [
        f,
        Math.max(0, Math.round((at - now) / 1000)),
      ]),
    );
    return {
      cap: s.dailyCap,
      used24h: this.ledger.count(now),
      capped: this.capped,
      intervalsS,
      nextPollInS,
    };
  }

  /** Its part of GET /rt/status (no secrets). */
  status(now = Date.now()): ProviderStatus {
    return {
      name: this.feed.name,
      polling: this.polling,
      hasKey: this.hasKey,
      pollingForS:
        this.pollingSince === undefined ?
          null
        : Math.round((now - this.pollingSince) / 1000),
      upstreamCalls: this.upstreamCalls,
      budget: this.budgetStatus(now),
      lastSnapshotAgeS:
        this.latest ? (now - this.latest.fetchedAt) / 1000 : null,
      vehicles: this.latest?.vehicles.length ?? 0,
      lastError: this.endpoints.positions.lastError ?? null,
      feeds: Object.fromEntries(
        POLL_FEEDS.map((f) => [
          f,
          {
            lastOkAgeS:
              this.endpoints[f].lastOkAt === undefined ?
                null
              : Math.round((now - this.endpoints[f].lastOkAt!) / 1000),
            lastError: this.endpoints[f].lastError ?? null,
          },
        ]),
      ),
      delayCoverage: this.delayCoverage,
      tripFeed: this.tripFeed,
      minDelayCoverage: this.feed.realtime.tripUpdatesMinCoverage,
    };
  }
}
