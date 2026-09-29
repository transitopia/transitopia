// The RT service: one upstream poller shared by all clients, an in-memory cache of the latest
// snapshot, the recorder, and a framework-free HTTP handler (docs/skytrain-viz-PLAN.md §4.6).
//
//   GET /rt/live                        latest snapshot (JSON, CORS, Cache-Control max-age=10)
//   GET /rt/history?date=YYYY-MM-DD&hour=HH   recorded snapshots for one local hour (NDJSON)
//   GET /rt/coverage?from=ms&to=ms      recorder coverage intervals
//   GET /rt/status                      poller health (no secrets)
//   GET /rt/alerts                      current TransLink alerts for our rail lines (and whether drafted)
//   GET /rt/changes?date=YYYYMMDD       bus trips cancelled or skipping stops, and bus route alerts, for a service date
//   GET /rt/dispatch                    live dispatch: current patch per service date (index)
//   GET /rt/dispatch/<date>/<v>.json    a patch version (immutable)
//   GET /rt/ais/fixes?date=YYYYMMDD[&after=cursor]   SeaBus AIS fixes for a service date (docs/skytrain-viz-PLAN.md §4.12)
//
// Client requests never trigger upstream calls: the upstream rate is fixed by the poll schedule,
// which keeps TransLink requests under a daily cap (packages/transit-core/src/rt/budget.ts, OPEN-QUESTIONS #29). A
// ledger of the last 24 hours' requests (var/rt-history/requests.json) enforces the cap and lets a
// restarted leader resume the schedule instead of polling everything at once.
// Only one process per machine polls and records (the "leader", holding var/rt-history/.lock);
// any other instance (e.g. `npm run dev` while `npm run server` runs) forwards /rt/* to the leader.

import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import rtConfig from "@transitopia/region-metro-vancouver/config/rt.json" with { type: "json" };
import seabusConfig from "@transitopia/region-metro-vancouver/config/seabus.json" with { type: "json" };
import type {
  FeedManifest,
  ServicePlan,
} from "@transitopia/transit-core/plan/types.ts";
import type {
  RtCoverageResponse,
  RtLiveResponse,
  RtSnapshot,
  RtVehicle,
} from "@transitopia/transit-core/rt/types.ts";
import {
  DISRUPTIONS_DIR,
  RT_HISTORY_DIR,
  AIS_HISTORY_DIR,
  PUBLIC_DIR,
  PUBLIC_DATA_DIR,
} from "@transitopia/pipelines/lib/paths.ts";
import { aisstreamApiKey, translinkApiKey } from "../secrets.ts";
import { AisFeed, type AisConfig } from "./ais.ts";
import {
  encodeFixes,
  type AisFixesResponse,
} from "@transitopia/transit-core/ais/fixes.ts";
import { Recorder } from "./recorder.ts";
import { LiveDispatcher, type LiveDispatchOptions } from "./dispatch.ts";
import {
  delayFor,
  fetchAlerts,
  fetchPositions,
  fetchTripUpdates,
  type TripDelays,
} from "./upstream.ts";
import { ServiceChanges } from "./changes.ts";
import type { RtRouteAlert } from "@transitopia/transit-core/rt/changes.ts";
import { localDate } from "@transitopia/transit-core/time.ts";
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
  type CadenceConfig,
  type PollFeed,
} from "@transitopia/transit-core/rt/budget.ts";

const CADENCE = cadence(rtConfig as unknown as CadenceConfig);
const SCHEDULE = (rtConfig as unknown as CadenceConfig).poll;

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
  /** Live dispatch (docs/skytrain-viz-PLAN.md §4.11): on by default; false disables it, an object configures it. */
  dispatch?: boolean | LiveDispatchOptions;
  log?: (msg: string) => void;
}

export class RtService {
  private apiKey: string | undefined;
  private latest: RtSnapshot | null = null;
  private delays: TripDelays = new Map();
  private routeKeyById = new Map<string, string>();
  /** GTFS route_id → our key for SkyTrain lines (alerts). */
  private railKeyById = new Map<string, string>();
  private alerts: ServiceAlert[] = [];
  private alertDrafts: AlertDrafts;
  readonly changes: ServiceChanges;
  private routesLoadedFrom: number | undefined;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private running = false;
  private lastError: string | undefined;
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
  readonly recorder: Recorder;
  readonly dispatcher: LiveDispatcher | undefined;
  readonly ais: AisFeed | undefined;
  private log: (msg: string) => void;
  private record: boolean;
  private leaderUrl: string | undefined;
  private ownsLock = false;

  constructor(opts: RtServiceOptions = {}) {
    this.recorder = new Recorder(
      opts.historyDir ?? RT_HISTORY_DIR,
      CADENCE.coverageGapMs,
    );
    this.log = opts.log ?? ((m) => console.log(`[rt] ${m}`));
    this.record = opts.record ?? true;
    this.apiKey =
      opts.apiKey === null ? undefined : (opts.apiKey ?? translinkApiKey());
    this.dispatcher =
      opts.dispatch === false ?
        undefined
      : new LiveDispatcher({
          log: this.log,
          ...(typeof opts.dispatch === "object" ? opts.dispatch : {}),
        });
    const aisKey =
      opts.aisApiKey === null ?
        undefined
      : (opts.aisApiKey ?? aisstreamApiKey());
    if (aisKey) {
      this.ais = new AisFeed({
        apiKey: aisKey,
        cfg: seabusConfig.ais as unknown as AisConfig,
        route: "seabus",
        recorder: new Recorder(
          opts.aisHistoryDir ?? AIS_HISTORY_DIR,
          seabusConfig.ais.coverageGapS * 1000,
        ),
        record: this.record,
        log: (m) => this.log(`AIS: ${m}`),
      });
    }
    this.changes = new ServiceChanges(
      join(this.recorder.dir, "changes"),
      this.record,
    );
    this.alertDrafts = new AlertDrafts({
      disruptionsDir: opts.disruptionsDir ?? DISRUPTIONS_DIR,
      historyDir: this.recorder.dir,
      log: this.log,
    });
  }

  get hasKey(): boolean {
    return Boolean(this.apiKey);
  }

  private get lockPath(): string {
    return join(this.recorder.dir, ".lock");
  }

  /** Become the leader, or find the live leader to forward to. */
  private async acquireLock(port: number | undefined): Promise<boolean> {
    try {
      const lock = JSON.parse(await readFile(this.lockPath, "utf8")) as {
        pid: number;
        port?: number;
      };
      if (lock.pid !== process.pid && isAlive(lock.pid) && lock.port) {
        this.leaderUrl = `http://localhost:${lock.port}`;
        return false;
      }
    } catch {
      // No lock (or unreadable): take it.
    }
    await this.recorder.init();
    await writeFile(this.lockPath, JSON.stringify({ pid: process.pid, port }));
    this.ownsLock = true;
    return true;
  }

  /** @param port the port this process serves /rt/* on, advertised to followers. */
  async start(port?: number): Promise<void> {
    if (this.running) return;
    this.running = true;
    if ((this.apiKey || this.ais) && !(await this.acquireLock(port))) {
      this.log(
        `Another RT service (pid in ${this.lockPath}) is polling; forwarding /rt/* to ${this.leaderUrl}`,
      );
      return;
    }
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
    if (this.record) this.latest = (await this.recorder.lastSnapshot()) ?? null;
    const now = Date.now();
    this.log(
      `Polling TransLink on a schedule (now every ${pollIntervalS(SCHEDULE, "positions", now)}s positions, `
        + `${pollIntervalS(SCHEDULE, "tripUpdates", now)}s trip updates, ${pollIntervalS(SCHEDULE, "alerts", now)}s alerts; `
        + `${this.ledger.count(now)}/${SCHEDULE.dailyCap} requests used in the last 24 h); recording to ${this.recorder.dir}`,
    );
    this.loop("tripUpdates", () => this.pollTripUpdates());
    this.loop("positions", () => this.pollPositions());
    this.loop("alerts", () => this.pollAlerts());
  }

  private get ledgerPath(): string {
    return join(this.recorder.dir, "requests.json");
  }

  private async loadLedger(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.ledgerPath, "utf8")) as {
        requests?: [number, PollFeed][];
      };
      this.ledger = new RequestLedger(SCHEDULE.dailyCap, raw.requests ?? []);
    } catch {
      // No ledger yet (first run, or a history dir without one).
    }
  }

  /** Persist the ledger (serialised, atomic), so restarts keep counting. */
  private saveLedger(): Promise<void> {
    const text = JSON.stringify(this.ledger);
    this.ledgerWrite = this.ledgerWrite
      .then(async () => {
        const tmp = `${this.ledgerPath}.tmp`;
        await writeFile(tmp, text);
        await rename(tmp, this.ledgerPath);
      })
      .catch((e) =>
        this.log(
          `could not save request ledger (${e instanceof Error ? e.message : e})`,
        ),
      );
    return this.ledgerWrite;
  }

  private async pollAlerts(): Promise<void> {
    const decoded = await fetchAlerts(this.apiKey!);
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
    this.dispatcher?.stop();
    this.ais?.stop();
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    if (this.ownsLock) {
      this.ownsLock = false;
      void rm(this.lockPath, { force: true });
    }
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
  private loop(feed: PollFeed, fn: () => Promise<void>): void {
    const schedule = (at: number) => {
      this.nextPollAt[feed] = at;
      if (this.running)
        this.timers.push(setTimeout(tick, Math.max(0, at - Date.now())));
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
        await fn();
        this.consecutiveErrors[feed] = 0;
      } catch (e) {
        const n = ++this.consecutiveErrors[feed];
        this.lastError = e instanceof Error ? e.message : String(e);
        delay = Math.min(Math.max(300_000, delay), delay * 2 ** Math.min(4, n));
        this.log(
          `${feed} poll failed (${this.lastError}); retrying in ${Math.round(delay / 1000)}s`,
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
        `Could not read timetable manifest (${e instanceof Error ? e.message : e}); run "npm run data:gtfs".`,
      );
    }
  }

  private async pollTripUpdates(): Promise<void> {
    const { delays, changes } = await fetchTripUpdates(
      this.apiKey!,
      AbortSignal.timeout(15_000),
    );
    this.delays = delays;
    const today = localDate(Date.now());
    await this.changes.updateTrips(
      changes
        .filter((c) => c.routeId && this.routeKeyById.has(c.routeId))
        .map((c) => ({
          tripId: c.tripId,
          date:
            c.startDate && /^\d{8}$/.test(c.startDate) ? c.startDate : today,
          cancelled: c.cancelled,
          skippedStopIds: c.skippedStopIds,
        })),
    );
  }

  private async pollPositions(): Promise<void> {
    await this.loadRoutes();
    const fetchedAt = Date.now();
    const decoded = await fetchPositions(
      this.apiKey!,
      AbortSignal.timeout(15_000),
    );
    const vehicles: RtVehicle[] = [];
    for (const p of decoded.positions) {
      const routeKey = p.routeId ? this.routeKeyById.get(p.routeId) : undefined;
      if (!routeKey) continue;
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
      vehicles.push(v);
    }
    this.latest = { fetchedAt, headerTs: decoded.headerTs, vehicles };
    this.lastError = undefined;
    if (this.record) await this.recorder.record(this.latest);
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
    else if (this.lastError && r.stale) r.error = this.lastError;
    if (this.dispatcher) r.dispatch = this.dispatcher.pointer();
    return r;
  }

  async handle(pathname: string, params: URLSearchParams): Promise<HttpResult> {
    if (this.leaderUrl) return this.forward(pathname, params);
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
        const headers: Record<string, string> = {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          ...CORS,
          // Closed hours never change; the open hour does.
          "Cache-Control": f.gzip ? "public, max-age=86400" : "no-cache",
        };
        if (f.gzip) headers["Content-Encoding"] = "gzip";
        return { status: 200, headers, body: await readFile(f.path) };
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
          hasKey: this.hasKey,
          uptimeS: Math.round((Date.now() - this.startedAt) / 1000),
          upstreamCalls: this.upstreamCalls,
          budget: this.budgetStatus(),
          lastSnapshotAgeS:
            this.latest ? (Date.now() - this.latest.fetchedAt) / 1000 : null,
          vehicles: this.latest?.vehicles.length ?? 0,
          lastError: this.lastError ?? null,
          ais: this.ais?.status() ?? null,
        });
      default:
        return json(404, { error: "Not found" });
    }
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

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
