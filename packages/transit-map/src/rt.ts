// Browser side of real-time buses (packages/transit-core/DESIGN.md#buses). Near "now" it polls /rt/live; at other times
// it loads recorded hours from /rt/history. It also tracks recorder coverage, which decides per
// instant whether buses are shown from RT data (observed/interpolated) or schedule (estimated), and
// loads TransLink's service changes (cancelled trips, skipped stops, detours) for the days shown.

import rtConfig from "@transitopia/region-metro-vancouver/config/rt.json";
import {
  coverageContains,
  decodeSnapshot,
  type RtCoverageResponse,
  type RtLiveResponse,
  type RtSnapshot,
} from "@transitopia/transit-core/rt/types.ts";
import { RtTimeline } from "@transitopia/transit-core/rt/timeline.ts";
import {
  Predictor,
  type PredictionConfig,
  type RtProfileFile,
} from "@transitopia/transit-core/rt/profile.ts";
import type {
  PreparedPlan,
  ScheduleCorrections,
  VehicleState,
} from "@transitopia/transit-core/schedule/engine.ts";
import {
  delayCorrections,
  type TripDelay,
} from "@transitopia/transit-core/rt/carry.ts";
import {
  changesView,
  type ChangesView,
  type RtDayChanges,
} from "@transitopia/transit-core/rt/changes.ts";
import {
  addDays,
  localDate,
  toWallTime,
} from "@transitopia/transit-core/time.ts";
import { kinematics } from "./plans.ts";
import {
  cadence,
  type CadenceConfig,
} from "@transitopia/transit-core/rt/budget.ts";

/** Live mode applies when the clock is within this of wall-clock time. */
const LIVE_WINDOW_MS = 10 * 60_000;
/** How much live history to keep in memory for interpolation. */
const LIVE_BUFFER_MS = 20 * 60_000;
const MAX_HOURS_CACHED = 8;
/** Recorded hours fetched at once: scrubbing across the day shouldn't fetch every hour it passes. */
const MAX_HOUR_LOADS = 2;
/** Timelines kept for recently shown snapshot sets: scrubbing back and forth near hour boundaries switches between them. */
const MAX_TIMELINES_CACHED = 4;
const PREDICTION = rtConfig.prediction as unknown as PredictionConfig;
/** Thresholds that follow how often the server polls (packages/transit-core/src/rt/budget.ts). */
const CADENCE = cadence(rtConfig as unknown as CadenceConfig);
/** Service changes for today and yesterday are refetched this often (cheap: they come from our server, which polls TransLink on its own schedule). */
const CHANGES_REFRESH_MS = 60_000;
const MAX_CHANGE_DAYS_CACHED = 6;

export type RtMode =
  | "live"
  | "recorded"
  /** Recorded data covers the time but is still loading (schedule estimates meanwhile). */
  | "loading"
  | "estimated"
  | "unavailable";

interface DayChanges {
  data?: RtDayChanges;
  fetchedAt: number;
  loading: boolean;
}

interface HourChunk {
  status: "loading" | "ready" | "missing";
  snapshots: RtSnapshot[];
}

export class RtClient {
  private live: RtSnapshot[] = [];
  private liveError: string | undefined;
  private dispatch: Record<string, string> | undefined;
  private liveTimer: ReturnType<typeof setTimeout> | undefined;
  private hours = new Map<string, HourChunk>();
  private coverage: [number, number][] = [];
  private coverageRange: [number, number] | undefined;
  private coverageFetchedAt = 0;
  /** Most recently used last. */
  private timelines = new Map<string, RtTimeline>();
  private carryMemo:
    | {
        delays: TripDelay[];
        pp: PreparedPlan;
        version: number;
        result: ReturnType<typeof delayCorrections>;
      }
    | undefined;
  private changes = new Map<string, DayChanges>();
  /** Bumped whenever loaded service changes differ. */
  private changesVersion = 0;
  private view: { version: number; view: ChangesView } | undefined;
  private cancelledMemo = new Map<
    string,
    { version: number; corr: ScheduleCorrections | undefined }
  >();
  /** Per feed version: the predictor, once its travel-time profile has loaded (or turned out missing). */
  private predictors = new Map<string, Predictor | "loading">();
  private listeners = new Set<() => void>();
  available: boolean;
  /** URL prefixes of the published data and of the RT service (undefined: schedules only). */
  private readonly data: string;
  private readonly api: string | undefined;

  constructor(urls: { data: string; api: string | undefined }) {
    this.data = urls.data;
    this.api = urls.api;
    this.available = urls.api !== undefined;
    if (!this.available)
      this.liveError = "Real-time data isn't available on this site yet";
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  /** Called every frame with the clock time; schedules any fetches needed. */
  update(t: number): void {
    if (!this.api) return;
    const nearNow = Math.abs(t - Date.now()) < LIVE_WINDOW_MS;
    if (nearNow) this.ensureLivePolling();
    else this.stopLivePolling();
    if (!nearNow || t < Date.now() - CADENCE.maxInterpolateLimitS * 1000)
      this.ensureHours(t);
    if (this.available) this.ensureChanges(t);
  }

  /** Coverage intervals within [from, to], fetching if the cached range doesn't cover it. */
  coverageFor(from: number, to: number): [number, number][] {
    const now = Date.now();
    const includesNow = from <= now && now <= to;
    const stale = includesNow && now - this.coverageFetchedAt > 60_000;
    if (
      !this.coverageRange
      || from < this.coverageRange[0]
      || to > this.coverageRange[1]
      || stale
    ) {
      if (now - this.coverageFetchedAt > 5_000)
        void this.fetchCoverage(from, to);
    }
    const out = this.coverage.filter(([a, b]) => b >= from && a <= to);
    // The live buffer extends coverage to the present even before the index is refreshed.
    const span = this.liveSpan();
    if (span) out.push(span);
    return out;
  }

  /** RT vehicles at t, or undefined when RT data doesn't cover t (use schedule estimates). */
  vehiclesAt(
    t: number,
    pp: PreparedPlan | undefined,
    routes?: Set<string>,
  ): { mode: RtMode; vehicles?: VehicleState[] } {
    if (!this.available) return { mode: "unavailable" };
    const liveSpan = this.liveSpan();
    const inLive =
      liveSpan !== undefined
      && t >= liveSpan[0]
      && t <= liveSpan[1] + CADENCE.staleAfterMs(liveSpan[1]);
    const covered =
      inLive || coverageContains(this.coverage, t, CADENCE.coverageGapMs(t));
    if (!covered) return { mode: "estimated" };

    const snapshots = inLive ? this.live : this.snapshotsAround(t);
    if (!snapshots) return { mode: "loading" };
    return {
      mode: inLive ? "live" : "recorded",
      vehicles: this.timelineFor(snapshots, inLive, pp).vehiclesAt(t, routes),
    };
  }

  private timelineFor(
    snapshots: RtSnapshot[],
    live: boolean,
    pp: PreparedPlan | undefined,
  ): RtTimeline {
    const predictor = pp ? this.predictorFor(pp) : undefined;
    const key = `${live ? "live" : "rec"}:${snapshots.length}:${snapshots[0]?.fetchedAt}:${snapshots.at(-1)?.fetchedAt}:${pp?.plan.feedVersion}:${predictor ? "p" : ""}:${this.changesVersion}`;
    let timeline = this.timelines.get(key);
    if (timeline) this.timelines.delete(key);
    else {
      timeline = new RtTimeline(snapshots, pp, kinematics, {
        maxInterpolateS: CADENCE.maxInterpolateS,
        maxExtrapolateS: CADENCE.maxExtrapolateS,
        source: live ? "GTFS-RT live" : "GTFS-RT recorded",
        changes: this.changesView(),
        detourNearM: rtConfig.detourNearM,
        ...(predictor ? { prediction: { cfg: PREDICTION, predictor } } : {}),
      });
      if (this.timelines.size >= MAX_TIMELINES_CACHED)
        this.timelines.delete(this.timelines.keys().next().value!);
    }
    this.timelines.set(key, timeline);
    return timeline;
  }

  /**
   * RT bus delays at t carried forward into schedule corrections (per service date), and the trips
   * they affect. Uses the live buffer from its start onwards (including the future, when
   * fast-forwarding past the live edge), else recorded data covering t.
   */
  delayCorrections(
    t: number,
    pp: PreparedPlan | undefined,
  ):
    | { byDate: Map<string, ScheduleCorrections>; carried: Set<string> }
    | undefined {
    if (!this.available || !pp || !this.predictorFor(pp)) return undefined;
    const fromLive = this.live.length > 0 && t >= this.live[0]!.fetchedAt;
    const recorded =
      (
        !fromLive
        && coverageContains(this.coverage, t, CADENCE.coverageGapMs(t))
      ) ?
        this.snapshotsAround(t)
      : undefined;
    const snapshots = fromLive ? this.live : recorded;
    if (!snapshots) return undefined;
    const delays = this.timelineFor(snapshots, fromLive, pp).tripDelays(t);
    if (
      this.carryMemo?.delays !== delays
      || this.carryMemo.pp !== pp
      || this.carryMemo.version !== this.changesVersion
    ) {
      this.carryMemo = {
        delays,
        pp,
        version: this.changesVersion,
        result: delayCorrections(
          pp,
          delays,
          rtConfig.carry,
          this.changesView().cancelled,
        ),
      };
    }
    return this.carryMemo.result;
  }

  /** Trips TransLink cancelled on a service date, as corrections that hide their schedule estimates. */
  cancellationsFor(date: string): ScheduleCorrections | undefined {
    let m = this.cancelledMemo.get(date);
    if (m?.version !== this.changesVersion) {
      const ids = this.changesView().cancelledTrips(date);
      m = {
        version: this.changesVersion,
        corr:
          ids.length ?
            { trips: new Map(), cancelled: new Set(ids), consists: new Map() }
          : undefined,
      };
      this.cancelledMemo.set(date, m);
      if (this.cancelledMemo.size > MAX_CHANGE_DAYS_CACHED)
        this.cancelledMemo.delete(this.cancelledMemo.keys().next().value!);
    }
    return m.corr;
  }

  /** Lookups over every loaded day's service changes. */
  private changesView(): ChangesView {
    if (this.view?.version !== this.changesVersion) {
      const days = [...this.changes.values()].flatMap((d) =>
        d.data ? [d.data] : [],
      );
      this.view = {
        version: this.changesVersion,
        view: changesView(days, CADENCE.alertGraceMs),
      };
    }
    return this.view.view;
  }

  /** Loads the service changes for the dates around t, refreshing recent ones. */
  private ensureChanges(t: number): void {
    const now = Date.now();
    const today = localDate(t);
    const recentFrom = addDays(localDate(now), -1);
    for (const date of [addDays(today, -1), today]) {
      let e = this.changes.get(date);
      if (
        e
        && (e.loading
          || date < recentFrom
          || now - e.fetchedAt < CHANGES_REFRESH_MS)
      )
        continue;
      if (!e) this.changes.set(date, (e = { fetchedAt: 0, loading: false }));
      const entry = e;
      entry.loading = true;
      entry.fetchedAt = now;
      fetch(`${this.api}rt/changes?date=${date}`)
        .then((r) => (r.ok ? (r.json() as Promise<RtDayChanges>) : undefined))
        .catch(() => undefined)
        .then((data) => {
          entry.loading = false;
          if (!data || JSON.stringify(data) === JSON.stringify(entry.data))
            return;
          entry.data = data;
          this.changesVersion++;
          this.emit();
        });
    }
    for (const date of this.changes.keys()) {
      if (this.changes.size <= MAX_CHANGE_DAYS_CACHED) break;
      if (date === today || date === addDays(today, -1)) continue;
      this.changes.delete(date);
      this.changesVersion++;
    }
  }

  /** Profile-based predictor for a feed; undefined while its profile loads. */
  predictorFor(pp: PreparedPlan): Predictor | undefined {
    const version = pp.plan.feedVersion;
    const p = this.predictors.get(version);
    if (p === "loading") return undefined;
    if (p) return p;
    this.predictors.set(version, "loading");
    // Scenario plans ("<version>~<name>") share the base feed's profile.
    const base = version.split("~")[0];
    fetch(`${this.data}data/feeds/${base}/rt-profile.json`)
      .then((r) => (r.ok ? (r.json() as Promise<RtProfileFile>) : undefined))
      .catch(() => undefined)
      .then((profile) => {
        // Without a profile, the timetable still gives better predictions than a fixed speed.
        this.predictors.set(
          version,
          new Predictor(pp, PREDICTION, profile, (date, tripId) =>
            this.changesView().skipped(date, tripId),
          ),
        );
        this.emit();
      });
    return undefined;
  }

  /** Stop polling (the engine is being disposed). */
  stop(): void {
    this.stopLivePolling();
  }

  liveStatus(): string | undefined {
    return this.liveError;
  }

  /** Live dispatch versions from the last /rt/live response (service date → version). */
  dispatchPointer(): Record<string, string> | undefined {
    return this.dispatch;
  }

  // --- live ---

  private liveSpan(): [number, number] | undefined {
    const last = this.live.at(-1);
    if (
      !last
      || Date.now() - last.fetchedAt > CADENCE.staleAfterMs(last.fetchedAt)
    )
      return undefined;
    return [this.live[0]!.fetchedAt, last.fetchedAt];
  }

  private ensureLivePolling(): void {
    if (this.liveTimer !== undefined) return;
    const poll = async () => {
      try {
        const res = await fetch(`${this.api}rt/live`, { cache: "no-cache" });
        if (res.status === 404) {
          // No RT service (e.g. a static build without the proxy).
          this.available = false;
          this.liveError = "Real-time service not available";
          this.emit();
          return;
        }
        const body = (await res.json()) as RtLiveResponse;
        this.liveError = body.error;
        if (
          body.dispatch
          && JSON.stringify(body.dispatch) !== JSON.stringify(this.dispatch)
        ) {
          this.dispatch = body.dispatch;
          this.emit();
        }
        if (body.snapshot && !body.stale) {
          const s: RtSnapshot = {
            ...body.snapshot,
            receivedAt: Math.max(Date.now(), body.snapshot.fetchedAt),
          };
          if (!this.live.length || s.fetchedAt > this.live.at(-1)!.fetchedAt) {
            this.live.push(s);
            const cutoff = Date.now() - LIVE_BUFFER_MS;
            while (this.live.length > 2 && this.live[0]!.fetchedAt < cutoff)
              this.live.shift();
            this.emit();
          }
        }
      } catch {
        this.liveError = "Real-time service unreachable";
      }
      if (this.liveTimer !== undefined)
        this.liveTimer = setTimeout(poll, rtConfig.clientPollS * 1000);
    };
    this.liveTimer = setTimeout(poll, 0);
  }

  private stopLivePolling(): void {
    if (this.liveTimer === undefined) return;
    clearTimeout(this.liveTimer);
    this.liveTimer = undefined;
  }

  // --- recorded history ---

  private hourId(t: number): { id: string; date: string; hour: string } {
    const w = toWallTime(t);
    const date = `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`;
    const hour = String(w.hour).padStart(2, "0");
    return { id: `${date}T${hour}`, date, hour };
  }

  /** Load the hour containing t, plus the neighbouring hour when t is near a boundary. */
  private ensureHours(t: number): void {
    if (!coverageContains(this.coverage, t, 15 * 60_000)) return;
    const margin = CADENCE.maxInterpolateLimitS * 1000;
    const ids = new Map<string, { date: string; hour: string }>();
    // The hour containing t first: it's the one needed to show anything.
    for (const x of [t, t - margin, t + margin]) {
      const h = this.hourId(x);
      ids.set(h.id, h);
    }
    let loading = 0;
    for (const chunk of this.hours.values())
      if (chunk.status === "loading") loading++;
    for (const [id, { date, hour }] of ids) {
      const cached = this.hours.get(id);
      if (cached) {
        // Most recently used last.
        this.hours.delete(id);
        this.hours.set(id, cached);
        continue;
      }
      if (loading >= MAX_HOUR_LOADS) continue;
      loading++;
      const chunk: HourChunk = { status: "loading", snapshots: [] };
      this.hours.set(id, chunk);
      void this.loadHour(date, hour, chunk);
    }
    // Evict least-recently-used hours beyond the cache size.
    while (this.hours.size > MAX_HOURS_CACHED)
      this.hours.delete(this.hours.keys().next().value!);
  }

  private async loadHour(
    date: string,
    hour: string,
    chunk: HourChunk,
  ): Promise<void> {
    try {
      const res = await fetch(
        `${this.api}rt/history?date=${date}&hour=${hour}`,
      );
      if (!res.ok) {
        chunk.status = "missing";
        return;
      }
      const text = await res.text();
      chunk.snapshots = text.split("\n").filter(Boolean).map(decodeSnapshot);
      chunk.status = "ready";
      this.emit();
    } catch {
      chunk.status = "missing";
    }
  }

  /**
   * Snapshots from loaded hours around t, or undefined while the hour containing t loads. A
   * neighbouring hour still loading is left out until it arrives.
   */
  private snapshotsAround(t: number): RtSnapshot[] | undefined {
    const own = this.hours.get(this.hourId(t).id);
    if (!own || own.status === "loading") return undefined;
    const margin = CADENCE.maxInterpolateLimitS * 1000;
    const out: RtSnapshot[] = [];
    const seen = new Set<string>();
    for (const x of [t - margin, t, t + margin]) {
      const { id } = this.hourId(x);
      if (seen.has(id)) continue;
      seen.add(id);
      const chunk = this.hours.get(id);
      if (chunk?.status === "ready") out.push(...chunk.snapshots);
    }
    return out.sort((a, b) => a.fetchedAt - b.fetchedAt);
  }

  private async fetchCoverage(from: number, to: number): Promise<void> {
    if (!this.api) return;
    this.coverageFetchedAt = Date.now();
    // Fetch a generous window so scrubbing around the day doesn't refetch.
    const lo = from - 86_400_000;
    const hi = to + 86_400_000;
    try {
      const res = await fetch(
        `${this.api}rt/coverage?from=${Math.round(lo)}&to=${Math.round(hi)}`,
      );
      if (res.status === 404) {
        this.available = false;
        return;
      }
      const body = (await res.json()) as RtCoverageResponse;
      this.coverage = body.intervals;
      this.coverageRange = [lo, hi];
      this.emit();
    } catch {
      // Keep whatever coverage we had.
    }
  }
}
