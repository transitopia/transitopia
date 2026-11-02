// The RT service: one upstream poller per real-time feed shared by all clients (feed.ts), SeaBus AIS,
// live dispatch, and a framework-free HTTP handler (apps/server/README.md#real-time-service).
//
// The live endpoints and the per-date files they point to (apps/server/README.md#live-endpoints):
//
//   GET /feeds/<id>/live                          a feed's live sources in one shared, edge-cached response
//   GET /feeds/<id>/days/<YYYYMMDD>/ais           its vessels' AIS fixes recorded for a service date so far
//   GET /feeds/<id>/days/<YYYYMMDD>/changes       a service date's bus service changes (current)
//   GET /feeds/<id>/days/<YYYYMMDD>/changes/<v>.json   a version of them (immutable)
//   GET /networks/<id>/live/dispatch              a rail network's live dispatch, shared and edge-cached
//
// And:
//
//   GET /rt/history?feed=<id>&date=YYYY-MM-DD&hour=HH   a feed's recorded snapshots for one local hour (NDJSON)
//   GET /rt/coverage?feed=<id>&from=ms&to=ms           a feed's recorder coverage intervals
//   GET /rt/status                      the pollers' health (no secrets)
//   GET /rt/alerts                      current alerts for our rail lines (and whether drafted)
//   GET /networks/<id>/dispatch                    a rail network's live dispatch: current patch per service date (index)
//   GET /networks/<id>/dispatch/<date>/<v>.json    a patch version (immutable)
//
// `feed` is required where it's a parameter. Client requests never trigger upstream
// calls: each feed's rate is fixed by its poll schedule within its daily cap
// (packages/transit-core/src/rt/budget.ts). Only one process polls and records (the "leader",
// leader.ts); the others forward /rt/*, /feeds/* and /networks/* to it and take over when it goes away. Every
// route's vehicles are recorded (files and database); clients only ever see the routes we draw.

import { join } from "node:path";
import { createHash } from "node:crypto";
import translinkFeed from "@transitopia/config/feeds/translink/feed.json" with { type: "json" };
import { rtDefaults } from "../config.ts";
import {
  parseFeed,
  type FeedAis,
  type FeedInfo,
} from "@transitopia/transit-core/config.ts";
import type { RtCoverageResponse } from "@transitopia/transit-core/rt/types.ts";
import {
  type RailNetwork,
  RT_HISTORY_DIR,
  AIS_HISTORY_DIR,
} from "@transitopia/data/paths.ts";
import { aisstreamApiKey, secret } from "../secrets.ts";
import { AisFeed } from "./ais.ts";
import {
  encodeFixes,
  type AisDayResponse,
} from "@transitopia/transit-core/ais/fixes.ts";
import type { AisFix } from "@transitopia/transit-core/ais/match.ts";
import { Recorder } from "./recorder.ts";
import { LiveDispatcher, type LiveDispatchOptions } from "./dispatch.ts";
import type { Store } from "../store.ts";
import type { LeaderLock } from "../leader.ts";
import type { CorrectionsRepo } from "../corrections.ts";
import type { RtStatus } from "@transitopia/shared/admin-api.ts";
import { FeedPoller } from "./feed.ts";
import type { DecodedAlert } from "./upstream.ts";
import {
  addDays,
  localDate,
  isServiceDate,
  type ServiceDate,
} from "@transitopia/transit-core/time.ts";
import {
  LIVE_SCHEMA,
  type LiveAisSection,
  type LiveResponse,
} from "@transitopia/transit-core/rt/live.ts";
import { AlertDrafts } from "./alerts.ts";
import {
  draftFromAlert,
  type ServiceAlert,
} from "@transitopia/transit-core/disruption/alerts.ts";

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

/** How long the edge may keep a day file of a date still in progress (s); see feed.json → ais.liveWindowS. */
const AIS_DAY_MAX_AGE_S = 60;

export interface RtServiceOptions {
  /** Where recordings go: each feed's under <historyDir>/<feed>/. */
  historyDir?: string;
  /** Record snapshots to disk (default true). */
  record?: boolean;
  /**
   * Every feed served under /feeds/<id>/ (default: TransLink's); those with real time get a poller,
   * those with AIS a stream.
   */
  feeds?: FeedInfo[] | undefined;
  /**
   * Fetch upstream (default true). Without it nothing is polled, keyless feeds included: polling
   * spends a shared budget, so only production polls (RT_POLL).
   */
  poll?: boolean;
  /** Override every feed's key lookup (env / .secrets); null means no keys. */
  apiKey?: string | null;
  /** Override the aisstream.io key lookup; null means no key (no AIS feed). */
  aisApiKey?: string | null;
  /** Where AIS fixes go: each feed's under <aisHistoryDir>/<feed>/. */
  aisHistoryDir?: string;
  /** Live dispatch (apps/server/README.md#live-dispatch-and-previews): on by default; false disables it, an object configures it. */
  dispatch?: boolean | LiveDispatchOptions;
  /**
   * Record to PostgreSQL as well as files, and keep the request ledger there. The server always
   * has one; without it (tests), the ledger is only in memory.
   */
  store?: Store | undefined;
  /**
   * Corrections in the database: alert drafts go there, and the dispatcher reads it. The server
   * always has them; without them (tests), there's no live dispatch and no alert drafts.
   */
  corrections?: CorrectionsRepo | undefined;
  /** Leader election (the server's: PgLeaderLock); without one (tests), this process leads. */
  leaderLock?: LeaderLock | undefined;
  /** Only forward /rt/* to this RT service (e.g. production's, for local development). */
  forwardTo?: string | undefined;
  /** Called when this process becomes the leader (e.g. to start the scheduled jobs). */
  onLead?: (() => void) | undefined;
  /**
   * The rail network (packages/data/src/paths.ts → railNetwork): its live dispatch is served under
   * /networks/<id>/, and its feed's alerts become disruption drafts. Without one, neither runs.
   */
  rail?: RailNetwork | undefined;
  log?: (msg: string) => void;
}

/** How often a follower tries to become the leader (ms). */
const LEADER_RETRY_MS = 30_000;

export class RtService {
  private alerts: ServiceAlert[] = [];
  /** Drafts from the rail feed's alerts (none without a rail network or corrections). */
  readonly alertDrafts: AlertDrafts | undefined;
  /** One per feed with real time, by feed id. */
  readonly pollers = new Map<string, FeedPoller>();
  /** The feeds served under /feeds/<id>/. */
  readonly feeds: ReadonlySet<string>;
  /** The rail network, if this server has one: live dispatch and alert drafts are its. */
  readonly rail: RailNetwork | undefined;
  private running = false;
  private startedAt = Date.now();
  readonly dispatcher: LiveDispatcher | undefined;
  /**
   * Feeds whose vessels report AIS (feed.json → ais), by feed id, each with its stream when this
   * process streams (a key, RT_POLL). aisstream.io allows 3 connections per account: one per feed.
   */
  readonly aisFeeds = new Map<
    string,
    { cfg: FeedAis; stream: AisFeed | undefined }
  >();
  private log: (msg: string) => void;
  private record: boolean;
  private historyDir: string;
  private leaderUrl: string | undefined;
  private isLeader = false;
  private leaderLock: LeaderLock | undefined;
  private leaderRetry: ReturnType<typeof setTimeout> | undefined;
  private forwardOnly: boolean;
  readonly store: Store | undefined;
  private onLead: (() => void) | undefined;

  constructor(opts: RtServiceOptions = {}) {
    this.rail = opts.rail;
    this.feeds = new Set(
      (opts.feeds ?? [parseFeed(translinkFeed)]).map((f) => f.id),
    );
    this.historyDir = opts.historyDir ?? RT_HISTORY_DIR;
    this.log = opts.log ?? ((m) => console.log(`[rt] ${m}`));
    this.record = opts.record ?? true;
    this.store = opts.store;
    this.leaderLock = opts.leaderLock;
    this.forwardOnly = Boolean(opts.forwardTo);
    this.onLead = opts.onLead;
    if (opts.forwardTo) this.leaderUrl = opts.forwardTo.replace(/\/$/, "");
    const poll = !opts.forwardTo && (opts.poll ?? true);
    const railFeeds = new Set(this.rail ? [this.rail.feed] : []);
    for (const feed of opts.feeds ?? [parseFeed(translinkFeed)]) {
      const rt = feed.realtime;
      if (!rt) continue;
      const apiKey =
        rt.apiKey === undefined || opts.apiKey === null ? undefined
        : opts.apiKey !== undefined ? opts.apiKey
        : secret(rt.apiKey);
      this.pollers.set(
        feed.id,
        new FeedPoller({
          feed: { ...feed, realtime: rt },
          apiKey,
          poll,
          historyDir: join(this.historyDir, feed.id),
          record: this.record,
          store: opts.store,
          log: this.log,
          // Drafts from the rail feed's alerts for its lines.
          ...(railFeeds.has(feed.id) ?
            {
              onAlerts: (alerts: DecodedAlert[], rail: Map<string, string>) =>
                this.railAlerts(alerts, rail),
            }
          : {}),
        }),
      );
    }
    this.dispatcher =
      (
        opts.dispatch === false
        || opts.forwardTo
        || !this.rail
        || !opts.corrections
      ) ?
        undefined
      : new LiveDispatcher({
          net: this.rail,
          log: this.log,
          corrections: opts.corrections,
          ...(opts.store ? { store: opts.store } : {}),
          ...(typeof opts.dispatch === "object" ? opts.dispatch : {}),
        });
    const aisKey =
      opts.aisApiKey === null || opts.forwardTo || !poll ?
        undefined
      : (opts.aisApiKey ?? aisstreamApiKey());
    for (const feed of opts.feeds ?? [parseFeed(translinkFeed)]) {
      const cfg = feed.ais;
      if (!cfg) continue;
      const stream =
        aisKey ?
          new AisFeed({
            apiKey: aisKey,
            cfg,
            route: cfg.route,
            timezone: feed.timezone,
            recorder: new Recorder(
              join(opts.aisHistoryDir ?? AIS_HISTORY_DIR, feed.id),
              cfg.coverageGapS * 1000,
            ),
            record: this.record,
            log: (m) => this.log(`${feed.id} AIS: ${m}`),
            ...(opts.store ?
              {
                onBatch: (at: number, fixes: AisFix[]) =>
                  opts.store!.recordAis(feed.id, at, fixes),
              }
            : {}),
          })
        : undefined;
      this.aisFeeds.set(feed.id, { cfg, stream });
    }
    // Alert drafts and their history go with the rail feed's recordings.
    this.alertDrafts =
      this.rail && opts.corrections ?
        new AlertDrafts({
          repo: opts.corrections,
          historyDir: join(this.historyDir, this.rail.feed),
          log: this.log,
        })
      : undefined;
  }

  /** Whether this process polls, records and dispatches (false while following another). */
  get leading(): boolean {
    return this.isLeader;
  }

  /** The rail network's lines' alerts: drafts of the ones we can model (packages/transit-core/DESIGN.md#disruptions-and-alerts). */
  private async railAlerts(
    decoded: DecodedAlert[],
    railKeyById: Map<string, string>,
  ): Promise<void> {
    this.alerts = decoded
      .map((a) => ({
        id: a.id,
        lines: [
          ...new Set(
            a.routeIds
              .map((r) => railKeyById.get(r))
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
    await this.alertDrafts?.update(this.alerts);
  }

  /**
   * Become the leader, or find the leader to forward to (and keep trying to take over, so a
   * follower replaces a leader that stops).
   */
  private async acquireLeadership(): Promise<boolean> {
    if (!this.running) return false;
    if (!this.leaderLock) return true;
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

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    if (this.forwardOnly) {
      this.log(`Forwarding /rt/* to ${this.leaderUrl} (no polling here)`);
      return;
    }
    const polls = [...this.pollers.values()].some((p) => p.polling);
    const streams = [...this.aisFeeds.values()].some((a) => a.stream);
    if ((polls || streams || this.store) && !(await this.acquireLeadership()))
      return;
    await this.lead();
  }

  /** Start everything the leader does. */
  private async lead(): Promise<void> {
    if (!this.running || this.isLeader) return;
    this.isLeader = true;
    this.onLead?.();
    // The leader (or a standalone process without a key) dispatches; followers forward to it.
    this.dispatcher?.start();
    for (const [id, a] of this.aisFeeds) {
      if (!a.stream) {
        this.log(
          `No AISSTREAM_API_KEY (env or .secrets), or not polling: ${id}'s vessels estimated from the schedule.`,
        );
        continue;
      }
      this.log(`Streaming ${id}'s vessel positions from aisstream.io`);
      await a.stream.start();
    }
    // The last alerts, so /rt/alerts and /admin aren't empty until the first alerts poll.
    if (this.alertDrafts)
      this.alerts = await this.alertDrafts.restore().catch((e: Error) => {
        this.log(`could not restore alerts (${e.message})`);
        return [];
      });
    for (const p of this.pollers.values()) await p.start();
  }

  /** Stop everything; resolves once the pollers' work under way has finished (nothing writes after). */
  async stop(): Promise<void> {
    this.running = false;
    this.isLeader = false;
    this.dispatcher?.stop();
    for (const a of this.aisFeeds.values()) a.stream?.stop();
    if (this.leaderRetry) clearTimeout(this.leaderRetry);
    void this.leaderLock?.release();
    await Promise.all([...this.pollers.values()].map((p) => p.stop()));
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
   * GET /feeds/<id>/live: a feed's live sources in one response, the same for every visitor
   * (packages/transit-core/src/rt/live.ts): "vehicles" and "changes" where it has real time, "ais"
   * where its vessels report AIS.
   */
  async liveFeed(feed: string, now = Date.now()): Promise<LiveResponse> {
    const r: LiveResponse = { schema: LIVE_SCHEMA, nextAt: null, sources: {} };
    const due: number[] = [];
    const p = this.pollers.get(feed);
    if (p) {
      Object.assign(r.sources, await p.liveSections(now));
      const next = p.nextDataAt();
      if (next !== undefined) due.push(next);
    }
    const a = this.aisFeeds.get(feed);
    if (a) {
      r.sources["ais"] = this.aisSection(a);
      const next = a.stream?.nextBatchAt();
      if (next !== undefined) due.push(next);
    }
    if (due.length) r.nextAt = Math.min(...due);
    return r;
  }

  /** GET /networks/<id>/live/dispatch: the rail network's current dispatch patch per service date. */
  liveDispatch(dispatcher: LiveDispatcher): LiveResponse {
    return {
      schema: LIVE_SCHEMA,
      nextAt: null,
      sources: {
        dispatch: { kind: "dispatch", versions: dispatcher.index().byDate },
      },
    };
  }

  /** A live endpoint's response: the edge keeps it until new data is due, and never longer than clients poll. */
  private liveResult(r: LiveResponse, now: number): HttpResult {
    const maxAge =
      r.nextAt === null ?
        rtDefaults.clientPollS
      : Math.min(
          rtDefaults.clientPollS,
          Math.max(1, Math.ceil((r.nextAt - now) / 1000)),
        );
    return tagged(JSON.stringify(r), `public, max-age=${maxAge}`);
  }

  private aisSection(a: {
    cfg: FeedAis;
    stream: AisFeed | undefined;
  }): LiveAisSection {
    if (!a.stream)
      return {
        kind: "ais",
        encoding: "ais-fixes/1",
        route: a.cfg.route,
        status: "unavailable",
        error: "No aisstream.io API key configured",
        from: 0,
        to: 0,
        data: [],
      };
    const st = a.stream.status();
    const w = a.stream.liveWindow(a.cfg.liveWindowS * 1000);
    const ais: LiveAisSection = {
      kind: "ais",
      encoding: "ais-fixes/1",
      route: a.cfg.route,
      status: st.connected ? "ok" : "stale",
      from: w.from,
      to: w.to,
      data: encodeFixes(w.fixes),
    };
    if (!st.connected && st.lastError) ais.error = st.lastError;
    return ais;
  }

  /** GET /feeds/<id>/…: the feed's live endpoint and the per-date files it points to. */
  private async handleFeed(
    feed: string,
    rest: string,
    now = Date.now(),
  ): Promise<HttpResult> {
    if (!this.feeds.has(feed)) return json(404, { error: "No such feed" });
    if (rest === "/live")
      return this.liveResult(await this.liveFeed(feed, now), now);
    const day = /^\/days\/(\d{8})\/(ais|changes(?:\/([0-9a-f]+)\.json)?)$/.exec(
      rest,
    );
    if (!day || !isServiceDate(day[1]!))
      return json(404, { error: "Not found" });
    return day[2] === "ais" ?
        this.aisDay(feed, day[1], now)
      : this.changesDay(feed, day[1], day[3], now);
  }

  /** A feed's AIS fixes recorded for a service date so far (its day file). */
  private async aisDay(
    feed: string,
    date: ServiceDate,
    now: number,
  ): Promise<HttpResult> {
    const ais = this.aisFeeds.get(feed);
    if (!ais) return json(404, { error: "Not found" });
    let body: AisDayResponse;
    if (ais.stream) {
      const st = ais.stream.status();
      const day = await ais.stream.dayFile(date, now);
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

  /** A feed's bus service changes for a service date: the current version, or one by its id (immutable). */
  private async changesDay(
    feed: string,
    date: ServiceDate,
    version: string | undefined,
    now: number,
  ): Promise<HttpResult> {
    const poller = this.pollers.get(feed);
    if (!poller) return json(404, { error: "Not found" });
    if (version) {
      // Asked for by a pointer from the live endpoint, so normally still kept.
      const body = poller.changes.version(date, version);
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
      (await poller.changes.versioned(date)).body,
      `public, max-age=${recent ? 30 : 3600}`,
    );
  }

  async handle(pathname: string, params: URLSearchParams): Promise<HttpResult> {
    if (this.leaderUrl) return this.forward(pathname, params);
    const inFeed = /^\/feeds\/([^/]+)(\/.*)$/.exec(pathname);
    if (inFeed) return this.handleFeed(inFeed[1]!, inFeed[2]!);
    const inNetwork = /^\/networks\/([^/]+)(\/.*)$/.exec(pathname);
    if (inNetwork) {
      if (inNetwork[1] !== this.rail?.network)
        return json(404, { error: "No such rail network" });
      if (inNetwork[2] === "/live/dispatch")
        return this.dispatcher ?
            this.liveResult(this.liveDispatch(this.dispatcher), Date.now())
          : json(404, { error: "Live dispatch is off" });
      const dispatch = /^\/dispatch(\/.*)?$/.exec(inNetwork[2]!);
      return dispatch ?
          this.handleDispatch(dispatch[1] ?? "")
        : json(404, { error: "Not found" });
    }
    // A feed's poller, for the endpoints that take `feed=<id>`.
    const feedParam = params.get("feed");
    const poller = feedParam ? this.pollers.get(feedParam) : undefined;
    const noFeed = () =>
      feedParam ?
        json(404, { error: `No real-time feed ${feedParam}` })
      : json(400, { error: "feed=<id> required" });
    switch (pathname) {
      case "/rt/coverage": {
        if (!poller) return noFeed();
        const from = Number(params.get("from") ?? -Infinity);
        const to = Number(params.get("to") ?? Infinity);
        const body: RtCoverageResponse = {
          intervals: poller.coverage(from, to),
        };
        return json(200, body, { "Cache-Control": "public, max-age=30" });
      }
      case "/rt/history": {
        if (!poller) return noFeed();
        const f = await poller.trackedHour(
          params.get("date") ?? "",
          params.get("hour") ?? "",
        );
        if (!f) return json(404, { error: "No recording for that hour" });
        return {
          status: 200,
          headers: {
            "Content-Type": "application/x-ndjson; charset=utf-8",
            ...CORS,
            // Closed hours change only when the routes drawn do (trackedOnly), so a day is fine.
            "Cache-Control": f.closed ? "public, max-age=86400" : "no-cache",
            "Content-Encoding": "gzip",
          },
          body: f.body,
        };
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
        return json(200, this.status() satisfies RtStatus);
      default:
        return json(404, { error: "Not found" });
    }
  }

  /** GET /rt/status: the leader, each feed's poller and AIS (no secrets). */
  status(now = Date.now()) {
    return {
      running: this.running,
      leader: this.isLeader,
      database: Boolean(this.store),
      uptimeS: Math.round((now - this.startedAt) / 1000),
      providers: Object.fromEntries(
        [...this.pollers].map(([id, p]) => [id, p.status(now)]),
      ),
      ais: Object.fromEntries(
        [...this.aisFeeds].map(([id, a]) => [id, a.stream?.status() ?? null]),
      ),
    };
  }

  /** Live dispatch: the index of current versions (`rest` empty), or one immutable patch version (`/<date>/<v>.json`). */
  private async handleDispatch(rest: string): Promise<HttpResult> {
    if (!this.dispatcher) return json(404, { error: "Live dispatch is off" });
    if (rest === "" || rest === "/")
      return json(200, this.dispatcher.index(), {
        "Cache-Control": "public, max-age=10",
      });
    const m = /^\/(\d{8})\/([0-9a-z]+)\.json$/.exec(rest);
    const patch =
      m && isServiceDate(m[1]!) ?
        await this.dispatcher.patch(m[1], m[2]!)
      : undefined;
    if (!patch) return json(404, { error: "No such dispatch version" });
    return json(200, patch, {
      "Cache-Control": "public, max-age=31536000, immutable",
    });
  }
}
