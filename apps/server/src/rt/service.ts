// The RT service: one upstream poller shared by all clients, an in-memory cache of the latest
// snapshot, the recorder, and a framework-free HTTP handler (apps/server/README.md#real-time-service).
//
//   GET /rt/live                        latest snapshot (JSON, CORS, Cache-Control max-age=10)
//   GET /rt/history?date=YYYY-MM-DD&hour=HH   recorded snapshots for one local hour (NDJSON)
//   GET /rt/coverage?from=ms&to=ms      recorder coverage intervals
//   GET /rt/status                      poller health (no secrets)
//   GET /rt/alerts                      current TransLink alerts for our rail lines (and whether drafted)
//   GET /rt/changes?date=YYYYMMDD       bus trips cancelled or skipping stops, and bus route alerts, for a service date
//   GET /rt/dispatch                    live dispatch: current patch per service date (index)
//   GET /rt/dispatch/<date>/<v>.json    a patch version (immutable)
//   GET /rt/ais/fixes?date=YYYYMMDD[&after=cursor]   SeaBus AIS fixes for a service date (packages/transit-core/DESIGN.md#seabus-ais)
//
// The live endpoint and the per-date files it points to (apps/server/README.md#live-endpoint), which
// replace /rt/live, /rt/ais/fixes and /rt/changes (issue #178 removes those):
//
//   GET /regions/<id>/live/transit                          every live source in one shared, edge-cached response
//   GET /regions/<id>/days/<YYYYMMDD>/seabus/ais            SeaBus AIS fixes recorded for a service date so far
//   GET /regions/<id>/days/<YYYYMMDD>/translink/changes     a service date's bus service changes (current)
//   GET /regions/<id>/days/<YYYYMMDD>/translink/changes/<v>.json   a version of them (immutable)
//
// Client requests never trigger upstream calls: the upstream rate is fixed by the poll schedule,
// which keeps TransLink requests under a daily cap (packages/transit-core/src/rt/budget.ts, OPEN-QUESTIONS #29). A
// ledger of the last 24 hours' requests (the upstream_requests table, or var/rt-history/requests.json
// without a database) enforces the cap and lets a restarted leader resume the schedule instead of
// polling everything at once.
// Only one process polls and records (the "leader", leader.ts); the others forward /rt/* to it and
// take over when it goes away. Every route's vehicles are recorded (files and database); clients
// only ever see the routes we draw.

import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { gunzipSync, gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { join } from "node:path";
import region from "@transitopia/region-metro-vancouver/region.json" with { type: "json" };
import { rtConfig, seabusConfig } from "../config.ts";
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
  type RtCoverageResponse,
  type RtLiveResponse,
  type RtSnapshot,
  type RtVehicle,
} from "@transitopia/transit-core/rt/types.ts";
import {
  DISRUPTIONS_DIR,
  RT_HISTORY_DIR,
  AIS_HISTORY_DIR,
  PUBLIC_DIR,
  PUBLIC_DATA_DIR,
} from "@transitopia/data/paths.ts";
import { aisstreamApiKey, translinkApiKey } from "../secrets.ts";
import { AisFeed } from "./ais.ts";
import {
  encodeFixes,
  type AisDayResponse,
  type AisFixesResponse,
} from "@transitopia/transit-core/ais/fixes.ts";
import type { AisFix } from "@transitopia/transit-core/ais/match.ts";
import { Recorder } from "./recorder.ts";
import { LiveDispatcher, type LiveDispatchOptions } from "./dispatch.ts";
import type { Store } from "../store.ts";
import { FileLeaderLock, type LeaderLock } from "../leader.ts";
import type { CorrectionsRepo } from "../corrections.ts";
import type { RtStatus } from "@transitopia/shared/admin-api.ts";
import {
  delayFor,
  fetchAlerts,
  fetchPositions,
  fetchTripUpdates,
  tripFeedSummary,
  type TripDelays,
  type TripFeedSummary,
} from "./upstream.ts";
import { ServiceChanges } from "./changes.ts";
import type { RtRouteAlert } from "@transitopia/transit-core/rt/changes.ts";
import { addDays, localDate } from "@transitopia/transit-core/time.ts";
import {
  LIVE_SCHEMA,
  type LiveAisSection,
  type LiveTransitResponse,
  type LiveVehiclesSection,
  type VersionPointer,
} from "@transitopia/transit-core/rt/live.ts";
import { AlertDrafts } from "./alerts.ts";
import {
  draftFromAlert,
  type ServiceAlert,
} from "@transitopia/transit-core/disruption/alerts.ts";
import {
  cadence,
  pollIntervalS,
  POLL_FEEDS,
  RequestLedger,
  type PollFeed,
} from "@transitopia/transit-core/rt/budget.ts";

const CADENCE = cadence(rtConfig);
const SCHEDULE = rtConfig.poll;

export interface HttpResult {
  status: number;
  headers: Record<string, string>;
  body: string | Buffer;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function json(
  status: number,
  value: unknown,
  extra: Record<string, string> = {},
): HttpResult {
  return {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS,
      ...extra,
    },
    body: JSON.stringify(value),
  };
}

/** A JSON response with a weak ETag of its body, so an unchanged poll can be answered with a 304. */
function tagged(body: string, cacheControl: string): HttpResult {
  return {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS,
      "Cache-Control": cacheControl,
      ETag: `W/"${createHash("sha1").update(body).digest("hex").slice(0, 16)}"`,
    },
    body,
  };
}

/**
 * Whether an If-None-Match header names this ETag. Lenient about the form it comes back in: proxies
 * that compress (Caddy, Cloudflare) may weaken it or add a suffix such as "-gzip".
 */
export function notModified(
  ifNoneMatch: string | undefined,
  etag: string | undefined,
): boolean {
  const hash = etag && /"([^"-]+)/.exec(etag)?.[1];
  return Boolean(hash && ifNoneMatch?.includes(hash));
}

/** How long the edge may keep a day file of a date still in progress (s); see seabus.json → ais.liveWindowS. */
const AIS_DAY_MAX_AGE_S = 60;
const SEABUS_ROUTE = "seabus";
export interface RtServiceOptions {
  historyDir?: string;
  /** Record snapshots to disk (default true). */
  record?: boolean;
  /** Override the key lookup (env / .secrets); null means no key. */
  apiKey?: string | null;
  /** Override the aisstream.io key lookup; null means no key (no AIS feed). */
  aisApiKey?: string | null;
  aisHistoryDir?: string;
  /** Where confirmed disruptions live and alert drafts are written (default regions/metro-vancouver/disruptions). */
  disruptionsDir?: string;
  /** Live dispatch (apps/server/README.md#live-dispatch-and-previews): on by default; false disables it, an object configures it. */
  dispatch?: boolean | LiveDispatchOptions;
  /** Record to PostgreSQL as well as files (and keep the request ledger there). */
  store?: Store | undefined;
  /** Corrections in the database: alert drafts go there, and the dispatcher reads it. */
  corrections?: CorrectionsRepo | undefined;
  /** Leader election; default: the lock file in the history directory. */
  leaderLock?: LeaderLock | undefined;
  /** Only forward /rt/* to this RT service (e.g. production's, for local development). */
  forwardTo?: string | undefined;
  /** Called when this process becomes the leader (e.g. to start the scheduled jobs). */
  onLead?: (() => void) | undefined;
  /** The region served under /regions/<id>/ (default: the region.json this server is built for). */
  regionId?: string | undefined;
  log?: (msg: string) => void;
}

/** How often a follower tries to become the leader (ms). */
const LEADER_RETRY_MS = 30_000;
/** Closed history hours kept filtered in memory for /rt/history. */
const HISTORY_CACHE_HOURS = 48;
const TRANSLINK = "translink";

export class RtService {
  private apiKey: string | undefined;
  private latest: RtSnapshot | null = null;
  private delays: TripDelays = new Map();
  private routeKeyById = new Map<string, string>();
  /** GTFS route_id → our key for SkyTrain lines (alerts). */
  private railKeyById = new Map<string, string>();
  private alerts: ServiceAlert[] = [];
  readonly alertDrafts: AlertDrafts;
  readonly changes: ServiceChanges;
  private routesLoadedFrom: number | undefined;
  /** Each feed's pending poll (one per feed: a tick schedules the next). */
  private timers: Partial<Record<PollFeed, ReturnType<typeof setTimeout>>> = {};
  private running = false;
  /** Per feed: when it last polled successfully and its last error, so one feed's success can't hide another's failure. */
  private feeds: Record<PollFeed, { lastOkAt?: number; lastError?: string }> = {
    positions: {},
    tripUpdates: {},
    alerts: {},
  };
  /** Share of the latest poll's vehicles on a trip that have a TransLink delay (null before a poll). */
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
  private upstreamCalls = 0;
  private ledger = new RequestLedger(SCHEDULE.dailyCap);
  private ledgerWrite: Promise<void> = Promise.resolve();
  private nextPollAt: Partial<Record<PollFeed, number>> = {};
  private capped = false;
  private startedAt = Date.now();
  /** When this process started polling TransLink as the leader (feeds' ages count from here until their first success). */
  private pollingSince: number | undefined;
  readonly recorder: Recorder;
  readonly dispatcher: LiveDispatcher | undefined;
  readonly ais: AisFeed | undefined;
  private log: (msg: string) => void;
  private record: boolean;
  private leaderUrl: string | undefined;
  private isLeader = false;
  private leaderLock: LeaderLock | undefined;
  private leaderRetry: ReturnType<typeof setTimeout> | undefined;
  private forwardOnly: boolean;
  private port: number | undefined;
  readonly store: Store | undefined;
  private historyCache = new Map<string, Buffer>();
  private onLead: (() => void) | undefined;
  readonly regionId: string;

  constructor(opts: RtServiceOptions = {}) {
    this.regionId = opts.regionId ?? region.id;
    this.recorder = new Recorder(
      opts.historyDir ?? RT_HISTORY_DIR,
      CADENCE.coverageGapMs,
    );
    this.log = opts.log ?? ((m) => console.log(`[rt] ${m}`));
    this.record = opts.record ?? true;
    this.store = opts.store;
    this.leaderLock = opts.leaderLock;
    this.forwardOnly = Boolean(opts.forwardTo);
    this.onLead = opts.onLead;
    if (opts.forwardTo) this.leaderUrl = opts.forwardTo.replace(/\/$/, "");
    this.apiKey =
      opts.apiKey === null || opts.forwardTo ?
        undefined
      : (opts.apiKey ?? translinkApiKey());
    this.dispatcher =
      opts.dispatch === false || opts.forwardTo ?
        undefined
      : new LiveDispatcher({
          log: this.log,
          ...(opts.store ? { store: opts.store } : {}),
          ...(opts.corrections ? { corrections: opts.corrections } : {}),
          ...(typeof opts.dispatch === "object" ? opts.dispatch : {}),
        });
    const aisKey =
      opts.aisApiKey === null || opts.forwardTo ?
        undefined
      : (opts.aisApiKey ?? aisstreamApiKey());
    if (aisKey) {
      this.ais = new AisFeed({
        apiKey: aisKey,
        cfg: seabusConfig.ais,
        route: SEABUS_ROUTE,
        recorder: new Recorder(
          opts.aisHistoryDir ?? AIS_HISTORY_DIR,
          seabusConfig.ais.coverageGapS * 1000,
        ),
        record: this.record,
        log: (m) => this.log(`AIS: ${m}`),
        ...(opts.store ?
          {
            onBatch: (at: number, fixes: AisFix[]) =>
              opts.store!.recordAis(at, fixes),
          }
        : {}),
      });
    }
    this.changes = new ServiceChanges(
      join(this.recorder.dir, "changes"),
      this.record,
    );
    this.alertDrafts = new AlertDrafts({
      repo: opts.corrections,
      disruptionsDir: opts.disruptionsDir ?? DISRUPTIONS_DIR,
      historyDir: this.recorder.dir,
      log: this.log,
    });
  }

  get hasKey(): boolean {
    return Boolean(this.apiKey);
  }

  /** Whether this process polls, records and dispatches (false while following another). */
  get leading(): boolean {
    return this.isLeader;
  }

  /**
   * Become the leader, or find the leader to forward to (and keep trying to take over, so a
   * follower replaces a leader that stops).
   */
  private async acquireLeadership(): Promise<boolean> {
    if (!this.running) return false;
    await this.recorder.init();
    this.leaderLock ??= new FileLeaderLock(
      join(this.recorder.dir, ".lock"),
      this.port,
    );
    const state = await this.leaderLock.tryAcquire().catch((e: Error) => {
      this.log(`leader election failed (${e.message})`);
      return { leader: false as const, url: undefined };
    });
    if (state.leader) {
      this.leaderUrl = undefined;
      return true;
    }
    if (state.url !== this.leaderUrl)
      this.log(
        state.url ?
          `Another RT service is the leader; forwarding /rt/* to ${state.url}`
        : "Another RT service is the leader, at no advertised address; /rt/* unavailable here",
      );
    this.leaderUrl = state.url;
    this.leaderRetry = setTimeout(() => {
      void this.acquireLeadership().then((ok) => {
        if (ok) void this.lead();
      });
    }, LEADER_RETRY_MS);
    return false;
  }

  /** @param port the port this process serves /rt/* on, advertised to followers. */
  async start(port?: number): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.port = port;
    if (this.forwardOnly) {
      this.log(`Forwarding /rt/* to ${this.leaderUrl} (no polling here)`);
      return;
    }
    if (this.apiKey || this.ais || this.store) {
      if (!(await this.acquireLeadership())) return;
    }
    await this.lead();
  }

  /** Start everything the leader does. */
  private async lead(): Promise<void> {
    if (!this.running || this.isLeader) return;
    this.isLeader = true;
    this.onLead?.();
    // The leader (or a standalone process without a key) dispatches; followers forward to it.
    this.dispatcher?.start();
    await this.loadRoutes();
    if (this.ais) {
      this.log("Streaming SeaBus positions from aisstream.io");
      await this.ais.start();
    } else
      this.log(
        "No AISSTREAM_API_KEY (env or .secrets): SeaBus positions estimated from the schedule.",
      );
    if (!this.apiKey) {
      this.log(
        "No TRANSLINK_API_KEY (env or .secrets): real-time buses disabled, schedule estimates only.",
      );
      return;
    }
    await this.recorder.init();
    await this.loadLedger();
    // Serve the last recorded snapshot until the first poll (marked stale once it's too old).
    if (this.record) {
      const last = await this.recorder.lastSnapshot();
      this.latest = last ? trackedOnly(last) : null;
    }
    // Likewise the last alerts, so /rt/alerts and /admin aren't empty until the first alerts poll.
    this.alerts = await this.alertDrafts.restore().catch((e: Error) => {
      this.log(`could not restore alerts (${e.message})`);
      return [];
    });
    const now = Date.now();
    this.log(
      `Polling TransLink on a schedule (now every ${pollIntervalS(SCHEDULE, "positions", now)}s positions, `
        + `${pollIntervalS(SCHEDULE, "tripUpdates", now)}s trip updates, ${pollIntervalS(SCHEDULE, "alerts", now)}s alerts; `
        + `${this.ledger.count(now)}/${SCHEDULE.dailyCap} requests used in the last 24 h); recording to ${this.recorder.dir}`,
    );
    this.pollingSince = Date.now();
    this.loop("tripUpdates", () => this.pollTripUpdates());
    this.loop("positions", () => this.pollPositions());
    this.loop("alerts", () => this.pollAlerts());
  }

  private get ledgerPath(): string {
    return join(this.recorder.dir, "requests.json");
  }

  private async loadLedger(): Promise<void> {
    if (this.store) {
      this.ledger = new RequestLedger(
        SCHEDULE.dailyCap,
        await this.store.recentRequests(TRANSLINK),
      );
      return;
    }
    try {
      const raw = JSON.parse(await readFile(this.ledgerPath, "utf8")) as {
        requests?: [number, PollFeed][];
      };
      this.ledger = new RequestLedger(SCHEDULE.dailyCap, raw.requests ?? []);
    } catch {
      // No ledger yet (first run, or a history dir without one).
    }
  }

  /** Persist the ledger (serialised, atomic), so restarts keep counting. With a database, requests are rows instead. */
  private saveLedger(): Promise<void> {
    if (this.store) return Promise.resolve();
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

  private async pollAlerts(): Promise<void> {
    const decoded = await fetchAlerts(this.apiKey!);
    await this.store?.recordAlerts(decoded);
    this.alerts = decoded
      .map((a) => ({
        id: a.id,
        lines: [
          ...new Set(
            a.routeIds
              .map((r) => this.railKeyById.get(r))
              .filter((k): k is string => Boolean(k)),
          ),
        ],
        stopIds: a.stopIds,
        periods: a.periods,
        ...(a.cause !== undefined ? { cause: a.cause } : {}),
        ...(a.effect !== undefined ? { effect: a.effect } : {}),
        header: a.header,
        description: a.description,
      }))
      .filter((a) => a.lines.length > 0);
    await this.alertDrafts.update(this.alerts);
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

  stop(): void {
    this.running = false;
    this.isLeader = false;
    this.dispatcher?.stop();
    this.ais?.stop();
    for (const t of Object.values(this.timers)) clearTimeout(t);
    this.timers = {};
    if (this.leaderRetry) clearTimeout(this.leaderRetry);
    void this.leaderLock?.release();
  }

  /** Relay a request to the leader process. */
  private async forward(
    pathname: string,
    params: URLSearchParams,
  ): Promise<HttpResult> {
    try {
      const qs = params.toString();
      const res = await fetch(
        `${this.leaderUrl}${pathname}${qs ? `?${qs}` : ""}`,
        { signal: AbortSignal.timeout(10_000) },
      );
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        // fetch() already decoded the body.
        if (
          k !== "content-encoding"
          && k !== "content-length"
          && k !== "transfer-encoding"
        )
          headers[k] = v;
      });
      return {
        status: res.status,
        headers,
        body: Buffer.from(await res.arrayBuffer()),
      };
    } catch {
      // Leader gone: take over on the next start; for now report unavailable.
      return json(503, { error: "Real-time leader process unreachable" });
    }
  }

  /**
   * Poll `feed` on the schedule: at its current interval, backing off on consecutive errors, and
   * never beyond the daily cap (every attempt counts, failed or not). The first poll continues the
   * schedule from the last recorded request, so a restart doesn't poll everything at once.
   */
  private loop(
    feed: PollFeed,
    /** Resolves to the response size (bytes), where known. */
    fn: () => Promise<number | void>,
  ): void {
    const schedule = (at: number) => {
      this.nextPollAt[feed] = at;
      clearTimeout(this.timers[feed]);
      if (this.running)
        this.timers[feed] = setTimeout(tick, Math.max(0, at - Date.now()));
    };
    const tick = async () => {
      if (!this.running) return;
      const now = Date.now();
      const allowedAt = this.ledger.nextAllowedAt(now);
      if (allowedAt > now) {
        if (!this.capped)
          this.log(
            `daily cap of ${SCHEDULE.dailyCap} TransLink requests reached; pausing until ${new Date(allowedAt).toISOString()}`,
          );
        this.capped = true;
        schedule(allowedAt);
        return;
      }
      this.capped = false;
      this.ledger.record(feed, now);
      this.upstreamCalls++;
      void this.saveLedger();
      let delay = pollIntervalS(SCHEDULE, feed, now) * 1000;
      try {
        const bytes = await fn();
        this.consecutiveErrors[feed] = 0;
        this.feeds[feed] = { lastOkAt: now };
        void this.store
          ?.recordRequest({
            provider: TRANSLINK,
            feed,
            ts: now,
            status: 200,
            bytes: typeof bytes === "number" ? bytes : undefined,
          })
          .catch((e: Error) =>
            this.log(`could not record request (${e.message})`),
          );
      } catch (e) {
        const n = ++this.consecutiveErrors[feed];
        const error = e instanceof Error ? e.message : String(e);
        this.feeds[feed] = { ...this.feeds[feed], lastError: error };
        void this.store
          ?.recordRequest({
            provider: TRANSLINK,
            feed,
            ts: now,
            error,
          })
          .catch((e: Error) =>
            this.log(`could not record request (${e.message})`),
          );
        delay = Math.min(Math.max(300_000, delay), delay * 2 ** Math.min(4, n));
        this.log(
          `${feed} poll failed (${error}); retrying in ${Math.round(delay / 1000)}s`,
        );
      }
      schedule(now + delay);
    };
    const last = this.ledger.lastAt(feed);
    schedule(
      last === undefined ?
        Date.now()
      : last + pollIntervalS(SCHEDULE, feed, last) * 1000,
    );
  }

  /**
   * Map GTFS route_id → our route key, from every built feed (route IDs can differ between feeds).
   * Reloaded whenever the manifest changes, so routes added to the config (and rebuilt with
   * `npm run data`) are picked up without restarting the service.
   */
  private async loadRoutes(): Promise<void> {
    try {
      const manifestPath = join(PUBLIC_DATA_DIR, "manifest.json");
      const mtime = (await stat(manifestPath)).mtimeMs;
      if (mtime === this.routesLoadedFrom) return;
      const manifest = JSON.parse(
        await readFile(manifestPath, "utf8"),
      ) as FeedManifest;
      const map = new Map<string, string>();
      for (const f of manifest.feeds) {
        const plan = JSON.parse(
          await readFile(join(PUBLIC_DIR, f.path), "utf8"),
        ) as Pick<ServicePlan, "routes">;
        for (const r of plan.routes)
          if (r.kind === "bus") map.set(r.gtfsRouteId, r.key);
        for (const r of plan.routes)
          if (r.kind === "skytrain") this.railKeyById.set(r.gtfsRouteId, r.key);
      }
      if (this.routesLoadedFrom !== undefined)
        this.log(
          `Timetable data changed: now tracking ${[...new Set(map.values())].join(", ")}`,
        );
      this.routeKeyById = map;
      this.routesLoadedFrom = mtime;
    } catch (e) {
      this.log(
        `Could not read timetable manifest (${e instanceof Error ? e.message : String(e)}); run "npm run data:gtfs".`,
      );
    }
  }

  private async pollTripUpdates(): Promise<number> {
    const { delays, changes, trips, headerTs, bytes } = await fetchTripUpdates(
      this.apiKey!,
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
      date: c.startDate && /^\d{8}$/.test(c.startDate) ? c.startDate : today,
      cancelled: c.cancelled,
      skippedStopIds: c.skippedStopIds,
    }));
    await this.store?.recordTripChanges(rows);
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
      && t.busesMatched / t.busesOnTrips < rtConfig.tripUpdatesMinCoverage
    );
  }

  private async pollPositions(): Promise<number> {
    await this.loadRoutes();
    const fetchedAt = Date.now();
    const decoded = await fetchPositions(
      this.apiKey!,
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
      onTrips && this.feeds.tripUpdates.lastOkAt !== undefined ?
        withDelay / onTrips
      : null;
    if (this.record) await this.recorder.record(all);
    await this.store?.recordPositions(
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

  liveResponse(now = Date.now()): RtLiveResponse {
    const ageS = this.latest ? (now - this.latest.fetchedAt) / 1000 : null;
    const r: RtLiveResponse = {
      snapshot: this.latest,
      ageS,
      stale:
        ageS === null
        || !this.latest
        || ageS * 1000 > CADENCE.staleAfterMs(this.latest.fetchedAt),
    };
    if (!this.apiKey) r.error = "No TransLink API key configured";
    else if (this.feeds.positions.lastError && r.stale)
      r.error = this.feeds.positions.lastError;
    if (this.dispatcher) r.dispatch = this.dispatcher.pointer();
    return r;
  }

  /**
   * GET /regions/<id>/live/transit: every live source for the transit map in one response, the same
   * for every visitor (packages/transit-core/src/rt/live.ts).
   */
  async liveTransit(now = Date.now()): Promise<LiveTransitResponse> {
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

    let ais: LiveAisSection;
    if (this.ais) {
      const st = this.ais.status();
      const w = this.ais.liveWindow(seabusConfig.ais.liveWindowS * 1000);
      ais = {
        kind: "ais",
        encoding: "ais-fixes/1",
        route: SEABUS_ROUTE,
        status: st.connected ? "ok" : "stale",
        from: w.from,
        to: w.to,
        data: encodeFixes(w.fixes),
      };
      if (!st.connected && st.lastError) ais.error = st.lastError;
    } else
      ais = {
        kind: "ais",
        encoding: "ais-fixes/1",
        route: SEABUS_ROUTE,
        status: "unavailable",
        error: "No aisstream.io API key configured",
        from: 0,
        to: 0,
        data: [],
      };

    // Service changes for the dates the live view shows: today's and yesterday's (after midnight).
    const changes: Record<string, VersionPointer> = {};
    const today = localDate(now);
    for (const date of [addDays(today, -1), today]) {
      const { version } = await this.changes.versioned(date);
      changes[date] = {
        version,
        path: `regions/${this.regionId}/days/${date}/translink/changes/${version}.json`,
      };
    }

    const r: LiveTransitResponse = {
      schema: LIVE_SCHEMA,
      nextAt: this.nextDataAt() ?? null,
      sources: {
        "translink/vehicles": vehicles,
        "seabus/ais": ais,
        "translink/changes": { kind: "changes", versions: changes },
      },
    };
    if (this.dispatcher)
      r.sources["dispatch"] = {
        kind: "dispatch",
        versions: this.dispatcher.index().byDate,
      };
    return r;
  }

  /** When the next upstream poll or AIS batch with fixes is due, if any. */
  private nextDataAt(): number | undefined {
    const due = [
      ...(this.apiKey ? Object.values(this.nextPollAt) : []),
      this.ais?.nextBatchAt(),
    ].filter((t): t is number => t !== undefined);
    return due.length ? Math.min(...due) : undefined;
  }

  /** GET /regions/<id>/…: the live endpoint and the per-date files it points to. */
  private async handleRegion(
    id: string,
    rest: string,
    now = Date.now(),
  ): Promise<HttpResult> {
    if (id !== this.regionId) return json(404, { error: "No such region" });
    if (rest === "/live/transit") {
      const r = await this.liveTransit(now);
      // The edge keeps it until new data is due, and never longer than clients poll.
      const maxAge =
        r.nextAt === null ?
          rtConfig.clientPollS
        : Math.min(
            rtConfig.clientPollS,
            Math.max(1, Math.ceil((r.nextAt - now) / 1000)),
          );
      return tagged(JSON.stringify(r), `public, max-age=${maxAge}`);
    }
    const ais = /^\/days\/(\d{8})\/seabus\/ais$/.exec(rest);
    if (ais) {
      const date = ais[1]!;
      let body: AisDayResponse;
      if (this.ais) {
        const st = this.ais.status();
        const day = await this.ais.dayFile(date, now);
        body = {
          status: st.connected ? "ok" : "stale",
          to: day.to,
          complete: day.complete,
          fixes: encodeFixes(day.fixes),
        };
        if (!st.connected && st.lastError) body.error = st.lastError;
      } else
        body = {
          status: "unavailable",
          error: "No aisstream.io API key configured",
          to: 0,
          complete: false,
          fixes: [],
        };
      return tagged(
        JSON.stringify(body),
        body.complete ?
          "public, max-age=86400"
        : `public, max-age=${AIS_DAY_MAX_AGE_S}`,
      );
    }
    const changes =
      /^\/days\/(\d{8})\/translink\/changes(?:\/([0-9a-f]+)\.json)?$/.exec(
        rest,
      );
    if (changes) {
      const date = changes[1]!;
      const version = changes[2];
      if (version) {
        // Asked for by a pointer from the live endpoint, so normally still kept.
        const body = this.changes.version(date, version);
        return body === undefined ?
            json(
              404,
              { error: "No such version" },
              { "Cache-Control": "no-store" },
            )
          : tagged(body, "public, max-age=31536000, immutable");
      }
      const recent = date >= addDays(localDate(now), -1);
      return tagged(
        (await this.changes.versioned(date)).body,
        `public, max-age=${recent ? 30 : 3600}`,
      );
    }
    return json(404, { error: "Not found" });
  }

  async handle(pathname: string, params: URLSearchParams): Promise<HttpResult> {
    if (this.leaderUrl) return this.forward(pathname, params);
    const inRegion = /^\/regions\/([^/]+)(\/.*)$/.exec(pathname);
    if (inRegion) return this.handleRegion(inRegion[1]!, inRegion[2]!);
    if (pathname.startsWith("/rt/dispatch"))
      return this.handleDispatch(pathname);
    switch (pathname) {
      case "/rt/live":
        return json(200, this.liveResponse(), {
          "Cache-Control": "public, max-age=10",
        });
      case "/rt/coverage": {
        const from = Number(params.get("from") ?? -Infinity);
        const to = Number(params.get("to") ?? Infinity);
        const body: RtCoverageResponse = {
          intervals: this.recorder.coverage(from, to),
        };
        return json(200, body, { "Cache-Control": "public, max-age=30" });
      }
      case "/rt/history": {
        const f = await this.recorder.hourFile(
          params.get("date") ?? "",
          params.get("hour") ?? "",
        );
        if (!f) return json(404, { error: "No recording for that hour" });
        return {
          status: 200,
          headers: {
            "Content-Type": "application/x-ndjson; charset=utf-8",
            ...CORS,
            // Closed hours never change; the open hour does.
            "Cache-Control": f.gzip ? "public, max-age=86400" : "no-cache",
            "Content-Encoding": "gzip",
          },
          body: await this.trackedHour(f),
        };
      }
      case "/rt/ais/fixes": {
        const date = params.get("date") ?? "";
        if (!/^\d{8}$/.test(date))
          return json(400, { error: "date=YYYYMMDD required" });
        const st = this.ais?.status();
        const r =
          this.ais ?
            await this.ais.fixesFor(date, Number(params.get("after") ?? 0) || 0)
          : { fixes: [], cursor: 0 };
        const body: AisFixesResponse = {
          connected: st?.connected ?? false,
          lastMessageAgeS: st?.lastMessageAgeS ?? null,
          cursor: r.cursor,
          epoch: this.ais?.epoch ?? 0,
          fixes: encodeFixes(r.fixes),
        };
        if (!this.ais) body.error = "No aisstream.io API key configured";
        else if (st?.lastError && !st.connected) body.error = st.lastError;
        return json(200, body, { "Cache-Control": "no-cache" });
      }
      case "/rt/changes": {
        const date = params.get("date") ?? "";
        if (!/^\d{8}$/.test(date))
          return json(400, { error: "date=YYYYMMDD required" });
        return json(200, await this.changes.get(date), {
          "Cache-Control": "public, max-age=30",
        });
      }
      case "/rt/alerts":
        return json(
          200,
          {
            alerts: this.alerts.map((a) => ({
              ...a,
              drafted: Boolean(draftFromAlert(a).draft),
            })),
          },
          { "Cache-Control": "public, max-age=60" },
        );
      case "/rt/status":
        return json(200, {
          running: this.running,
          leader: this.isLeader,
          database: Boolean(this.store),
          hasKey: this.hasKey,
          uptimeS: Math.round((Date.now() - this.startedAt) / 1000),
          pollingForS:
            this.pollingSince === undefined ?
              null
            : Math.round((Date.now() - this.pollingSince) / 1000),
          upstreamCalls: this.upstreamCalls,
          budget: this.budgetStatus(),
          lastSnapshotAgeS:
            this.latest ? (Date.now() - this.latest.fetchedAt) / 1000 : null,
          vehicles: this.latest?.vehicles.length ?? 0,
          lastError: this.feeds.positions.lastError ?? null,
          feeds: Object.fromEntries(
            POLL_FEEDS.map((f) => [
              f,
              {
                lastOkAgeS:
                  this.feeds[f].lastOkAt === undefined ?
                    null
                  : Math.round((Date.now() - this.feeds[f].lastOkAt!) / 1000),
                lastError: this.feeds[f].lastError ?? null,
              },
            ]),
          ),
          delayCoverage: this.delayCoverage,
          tripFeed: this.tripFeed,
          minDelayCoverage: rtConfig.tripUpdatesMinCoverage,
          ais: this.ais?.status() ?? null,
        } satisfies RtStatus);
      default:
        return json(404, { error: "Not found" });
    }
  }

  /**
   * A recorded hour with only the routes we draw, gzipped. The files hold every route; closed
   * hours are filtered once and kept for a while.
   */
  private async trackedHour(f: {
    path: string;
    gzip: boolean;
  }): Promise<Buffer> {
    const hit = this.historyCache.get(f.path);
    if (hit) return hit;
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
    return out;
  }

  /** TransLink requests used against the daily cap, and when each feed polls next. */
  budgetStatus(now = Date.now()): {
    cap: number;
    used24h: number;
    capped: boolean;
    intervalsS: Record<PollFeed, number>;
    nextPollInS: Partial<Record<PollFeed, number>>;
  } {
    const intervalsS = Object.fromEntries(
      POLL_FEEDS.map((f) => [f, pollIntervalS(SCHEDULE, f, now)]),
    ) as Record<PollFeed, number>;
    const nextPollInS = Object.fromEntries(
      Object.entries(this.nextPollAt).map(([f, at]) => [
        f,
        Math.max(0, Math.round((at - now) / 1000)),
      ]),
    );
    return {
      cap: SCHEDULE.dailyCap,
      used24h: this.ledger.count(now),
      capped: this.capped,
      intervalsS,
      nextPollInS,
    };
  }

  /** Live dispatch: the index of current versions, or one immutable patch version. */
  private async handleDispatch(pathname: string): Promise<HttpResult> {
    if (!this.dispatcher) return json(404, { error: "Live dispatch is off" });
    if (pathname === "/rt/dispatch" || pathname === "/rt/dispatch/")
      return json(200, this.dispatcher.index(), {
        "Cache-Control": "public, max-age=10",
      });
    const m = /^\/rt\/dispatch\/(\d{8})\/([0-9a-z]+)\.json$/.exec(pathname);
    const patch = m ? await this.dispatcher.patch(m[1]!, m[2]!) : undefined;
    if (!patch) return json(404, { error: "No such dispatch version" });
    return json(200, patch, {
      "Cache-Control": "public, max-age=31536000, immutable",
    });
  }
}
