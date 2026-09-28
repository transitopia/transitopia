// The RT service: one upstream poller shared by all clients, an in-memory cache of the latest
// snapshot, the recorder, and a framework-free HTTP handler (PLAN.md §4.6).
//
//   GET /rt/live                        latest snapshot (JSON, CORS, Cache-Control max-age=10)
//   GET /rt/history?date=YYYY-MM-DD&hour=HH   recorded snapshots for one local hour (NDJSON)
//   GET /rt/coverage?from=ms&to=ms      recorder coverage intervals
//   GET /rt/status                      poller health (no secrets)
//   GET /rt/alerts                      current TransLink alerts for our rail lines (and whether drafted)
//   GET /rt/dispatch                    live dispatch: current patch per service date (index)
//   GET /rt/dispatch/<date>/<v>.json    a patch version (immutable)
//
// Client requests never trigger upstream calls: the upstream rate is fixed by the poll intervals.
// Only one process per machine polls and records (the "leader", holding data/rt-history/.lock);
// any other instance (e.g. `npm run dev` while `npm run server` runs) forwards /rt/* to the leader.

import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import rtConfig from '../../data/config/rt.json' with { type: 'json' };
import type { FeedManifest, ServicePlan } from '../../src/core/plan/types.ts';
import type { RtCoverageResponse, RtLiveResponse, RtSnapshot, RtVehicle } from '../../src/core/rt/types.ts';
import { PUBLIC_DATA_DIR, ROOT } from '../../scripts/lib/paths.ts';
import { translinkApiKey } from '../secrets.ts';
import { Recorder } from './recorder.ts';
import { LiveDispatcher, type LiveDispatchOptions } from './dispatch.ts';
import { delayFor, fetchAlerts, fetchPositions, fetchTripDelays, type TripDelays } from './upstream.ts';
import { AlertDrafts } from './alerts.ts';
import { draftFromAlert, type ServiceAlert } from '../../src/core/disruption/alerts.ts';

export interface HttpResult {
  status: number;
  headers: Record<string, string>;
  body: string | Buffer;
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' };

function json(status: number, value: unknown, extra: Record<string, string> = {}): HttpResult {
  return {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS, ...extra },
    body: JSON.stringify(value),
  };
}

export interface RtServiceOptions {
  historyDir?: string;
  /** Record snapshots to disk (default true). */
  record?: boolean;
  /** Override the key lookup (env / .secrets); null means no key. */
  apiKey?: string | null;
  /** Where confirmed disruptions live and alert drafts are written (default data/disruptions). */
  disruptionsDir?: string;
  /** Live dispatch (PLAN.md §4.11): on by default; false disables it, an object configures it. */
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
  private routesLoadedFrom: number | undefined;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private running = false;
  private lastError: string | undefined;
  private consecutiveErrors = 0;
  private upstreamCalls = 0;
  private startedAt = Date.now();
  readonly recorder: Recorder;
  readonly dispatcher: LiveDispatcher | undefined;
  private log: (msg: string) => void;
  private record: boolean;
  private leaderUrl: string | undefined;
  private ownsLock = false;

  constructor(opts: RtServiceOptions = {}) {
    this.recorder = new Recorder(opts.historyDir ?? join(ROOT, 'data', 'rt-history'), rtConfig.coverageGapS * 1000);
    this.log = opts.log ?? ((m) => console.log(`[rt] ${m}`));
    this.record = opts.record ?? true;
    this.apiKey = opts.apiKey === null ? undefined : (opts.apiKey ?? translinkApiKey());
    this.dispatcher = opts.dispatch === false ? undefined : new LiveDispatcher({ log: this.log, ...(typeof opts.dispatch === 'object' ? opts.dispatch : {}) });
    this.alertDrafts = new AlertDrafts({ disruptionsDir: opts.disruptionsDir ?? join(ROOT, 'data', 'disruptions'), historyDir: this.recorder.dir, log: this.log });
  }

  get hasKey(): boolean {
    return Boolean(this.apiKey);
  }

  private get lockPath(): string {
    return join(this.recorder.dir, '.lock');
  }

  /** Become the leader, or find the live leader to forward to. */
  private async acquireLock(port: number | undefined): Promise<boolean> {
    try {
      const lock = JSON.parse(await readFile(this.lockPath, 'utf8')) as { pid: number; port?: number };
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
    if (this.apiKey && !(await this.acquireLock(port))) {
      this.log(`Another RT service (pid in ${this.lockPath}) is polling; forwarding /rt/* to ${this.leaderUrl}`);
      return;
    }
    // The leader (or a standalone process without a key) dispatches; followers forward to it.
    this.dispatcher?.start();
    await this.loadRoutes();
    if (!this.apiKey) {
      this.log('No TRANSLINK_API_KEY (env or .secrets): real-time buses disabled, schedule estimates only.');
      return;
    }
    await this.recorder.init();
    this.log(
      `Polling TransLink every ${rtConfig.positionsIntervalS}s (positions) / ${rtConfig.tripUpdatesIntervalS}s (trip updates); ` +
        `recording to ${this.recorder.dir}`,
    );
    this.loop('delays', rtConfig.tripUpdatesIntervalS, () => this.pollDelays());
    this.loop('positions', rtConfig.positionsIntervalS, () => this.pollPositions());
    this.loop('alerts', rtConfig.alertsIntervalS, () => this.pollAlerts());
  }

  private async pollAlerts(): Promise<void> {
    this.upstreamCalls++;
    const decoded = await fetchAlerts(this.apiKey!);
    this.alerts = decoded
      .map((a) => ({ id: a.id, lines: [...new Set(a.routeIds.map((r) => this.railKeyById.get(r)).filter((k): k is string => Boolean(k)))], stopIds: a.stopIds, periods: a.periods, ...(a.cause !== undefined ? { cause: a.cause } : {}), ...(a.effect !== undefined ? { effect: a.effect } : {}), header: a.header, description: a.description }))
      .filter((a) => a.lines.length > 0);
    await this.alertDrafts.update(this.alerts);
  }

  stop(): void {
    this.running = false;
    this.dispatcher?.stop();
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    if (this.ownsLock) {
      this.ownsLock = false;
      void rm(this.lockPath, { force: true });
    }
  }

  /** Relay a request to the leader process. */
  private async forward(pathname: string, params: URLSearchParams): Promise<HttpResult> {
    try {
      const qs = params.toString();
      const res = await fetch(`${this.leaderUrl}${pathname}${qs ? `?${qs}` : ''}`, { signal: AbortSignal.timeout(10_000) });
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        // fetch() already decoded the body.
        if (k !== 'content-encoding' && k !== 'content-length' && k !== 'transfer-encoding') headers[k] = v;
      });
      return { status: res.status, headers, body: Buffer.from(await res.arrayBuffer()) };
    } catch {
      // Leader gone: take over on the next start; for now report unavailable.
      return json(503, { error: 'Real-time leader process unreachable' });
    }
  }

  /** Run `fn` now and then every `intervalS`, backing off on consecutive errors. */
  private loop(name: string, intervalS: number, fn: () => Promise<void>): void {
    const tick = async () => {
      if (!this.running) return;
      let delay = intervalS * 1000;
      try {
        await fn();
        this.consecutiveErrors = 0;
      } catch (e) {
        this.consecutiveErrors++;
        this.lastError = e instanceof Error ? e.message : String(e);
        delay = Math.min(300_000, delay * 2 ** Math.min(4, this.consecutiveErrors));
        this.log(`${name} poll failed (${this.lastError}); retrying in ${Math.round(delay / 1000)}s`);
      }
      if (this.running) this.timers.push(setTimeout(tick, delay));
    };
    void tick();
  }

  /**
   * Map GTFS route_id → our route key, from every built feed (route IDs can differ between feeds).
   * Reloaded whenever the manifest changes, so routes added to the config (and rebuilt with
   * `npm run data`) are picked up without restarting the service.
   */
  private async loadRoutes(): Promise<void> {
    try {
      const manifestPath = join(PUBLIC_DATA_DIR, 'manifest.json');
      const mtime = (await stat(manifestPath)).mtimeMs;
      if (mtime === this.routesLoadedFrom) return;
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as FeedManifest;
      const map = new Map<string, string>();
      for (const f of manifest.feeds) {
        const plan = JSON.parse(await readFile(join(ROOT, 'public', f.path), 'utf8')) as Pick<ServicePlan, 'routes'>;
        for (const r of plan.routes) if (r.kind === 'bus') map.set(r.gtfsRouteId, r.key);
        for (const r of plan.routes) if (r.kind === 'skytrain') this.railKeyById.set(r.gtfsRouteId, r.key);
      }
      if (this.routesLoadedFrom !== undefined) this.log(`Timetable data changed: now tracking ${[...new Set(map.values())].join(', ')}`);
      this.routeKeyById = map;
      this.routesLoadedFrom = mtime;
    } catch (e) {
      this.log(`Could not read timetable manifest (${e instanceof Error ? e.message : e}); run "npm run data:gtfs".`);
    }
  }

  private async pollDelays(): Promise<void> {
    this.upstreamCalls++;
    this.delays = await fetchTripDelays(this.apiKey!, AbortSignal.timeout(15_000));
  }

  private async pollPositions(): Promise<void> {
    await this.loadRoutes();
    this.upstreamCalls++;
    const fetchedAt = Date.now();
    const decoded = await fetchPositions(this.apiKey!, AbortSignal.timeout(15_000));
    const vehicles: RtVehicle[] = [];
    for (const p of decoded.positions) {
      const routeKey = p.routeId ? this.routeKeyById.get(p.routeId) : undefined;
      if (!routeKey) continue;
      const v: RtVehicle = { id: p.vehicleId, routeKey, lat: p.lat, lon: p.lon, ts: p.ts ?? decoded.headerTs };
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
      stale: ageS === null || ageS > rtConfig.staleAfterS,
    };
    if (!this.apiKey) r.error = 'No TransLink API key configured';
    else if (this.lastError && r.stale) r.error = this.lastError;
    if (this.dispatcher) r.dispatch = this.dispatcher.pointer();
    return r;
  }

  async handle(pathname: string, params: URLSearchParams): Promise<HttpResult> {
    if (this.leaderUrl) return this.forward(pathname, params);
    if (pathname.startsWith('/rt/dispatch')) return this.handleDispatch(pathname);
    switch (pathname) {
      case '/rt/live':
        return json(200, this.liveResponse(), { 'Cache-Control': 'public, max-age=10' });
      case '/rt/coverage': {
        const from = Number(params.get('from') ?? -Infinity);
        const to = Number(params.get('to') ?? Infinity);
        const body: RtCoverageResponse = { intervals: this.recorder.coverage(from, to) };
        return json(200, body, { 'Cache-Control': 'public, max-age=30' });
      }
      case '/rt/history': {
        const f = await this.recorder.hourFile(params.get('date') ?? '', params.get('hour') ?? '');
        if (!f) return json(404, { error: 'No recording for that hour' });
        const headers: Record<string, string> = {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          ...CORS,
          // Closed hours never change; the open hour does.
          'Cache-Control': f.gzip ? 'public, max-age=86400' : 'no-cache',
        };
        if (f.gzip) headers['Content-Encoding'] = 'gzip';
        return { status: 200, headers, body: await readFile(f.path) };
      }
      case '/rt/alerts':
        return json(200, { alerts: this.alerts.map((a) => ({ ...a, drafted: Boolean(draftFromAlert(a).draft) })) }, { 'Cache-Control': 'public, max-age=60' });
      case '/rt/status':
        return json(200, {
          running: this.running,
          hasKey: this.hasKey,
          uptimeS: Math.round((Date.now() - this.startedAt) / 1000),
          upstreamCalls: this.upstreamCalls,
          lastSnapshotAgeS: this.latest ? (Date.now() - this.latest.fetchedAt) / 1000 : null,
          vehicles: this.latest?.vehicles.length ?? 0,
          lastError: this.lastError ?? null,
        });
      default:
        return json(404, { error: 'Not found' });
    }
  }

  /** Live dispatch: the index of current versions, or one immutable patch version. */
  private async handleDispatch(pathname: string): Promise<HttpResult> {
    if (!this.dispatcher) return json(404, { error: 'Live dispatch is off' });
    if (pathname === '/rt/dispatch' || pathname === '/rt/dispatch/') return json(200, this.dispatcher.index(), { 'Cache-Control': 'public, max-age=10' });
    const m = /^\/rt\/dispatch\/(\d{8})\/([0-9a-z]+)\.json$/.exec(pathname);
    const patch = m ? await this.dispatcher.patch(m[1]!, m[2]!) : undefined;
    if (!patch) return json(404, { error: 'No such dispatch version' });
    return json(200, patch, { 'Cache-Control': 'public, max-age=31536000, immutable' });
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
