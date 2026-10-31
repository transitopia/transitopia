// Browser side of real-time buses (packages/transit-core/DESIGN.md#buses). Near "now" it takes snapshots from the live
// endpoint (acceptLive, polled by live.ts); at other times it loads recorded hours from /rt/history.
// It also tracks recorder coverage, which decides per instant whether buses are shown from RT data
// (observed/interpolated) or schedule (estimated), and loads TransLink's service changes (cancelled
// trips, skipped stops, detours) for the days shown: while live, the version the live endpoint
// points to; otherwise the current file, refreshed for recent days.

import {
  coverageContains,
  expandSnapshot,
  type CompactSnapshot,
  type RtCoverageResponse,
  type RtSnapshot,
} from "@transitopia/transit-core/rt/types.ts";
import {
  sectionOf,
  type LiveTransitResponse,
  type VersionPointer,
} from "@transitopia/transit-core/rt/live.ts";
import {
  SnapshotPacker,
  unpackSnapshots,
  type PackedSnapshots,
} from "@transitopia/transit-core/rt/packed.ts";
import { RtTimeline } from "@transitopia/transit-core/rt/timeline.ts";
import {
  bandOf,
  Predictor,
  type PredictionConfig,
} from "@transitopia/transit-core/rt/profile.ts";
import {
  bandFileName,
  decodeBandProfile,
  type RtBandProfile,
} from "@transitopia/transit-core/rt/profile-bands.ts";
import type {
  PreparedPlan,
  ScheduleCorrections,
  VehicleState,
} from "@transitopia/transit-core/schedule/engine.ts";
import {
  delayCorrections,
  type CarriedBus,
  type TripDelay,
} from "@transitopia/transit-core/rt/carry.ts";
import {
  changesView,
  type ChangesView,
  type RtDayChanges,
} from "@transitopia/transit-core/rt/changes.ts";
import {
  addDays,
  fromWallTime,
  localDate,
  toWallTime,
  type ServiceDate,
} from "@transitopia/transit-core/time.ts";
import type { RegionConfig } from "./config.ts";
import { cadence, type Cadence } from "@transitopia/transit-core/rt/budget.ts";
import { feedDataPath } from "@transitopia/transit-core/plan/types.ts";
import { LIVE_WINDOW_MS } from "./live.ts";

/** A feed without real-time data: nothing is ever fresh or covered. */
const NO_REALTIME: Cadence = {
  staleAfterMs: () => 0,
  coverageGapMs: () => 0,
  maxInterpolateS: () => 0,
  maxExtrapolateS: () => 0,
  maxInterpolateLimitS: 0,
  alertGraceMs: () => 0,
};

/** How much live history to keep in memory for interpolation. */
const LIVE_BUFFER_MS = 20 * 60_000;
/**
 * Recorded hours fetched at once, besides the one shown: the shown hour doesn't wait behind hours
 * scrubbed past or prefetched.
 */
const MAX_HOUR_LOADS = 2;
/** Loaded hours kept as RtSnapshot objects (the rest stay packed): the one shown and its neighbours. */
const MAX_HOURS_UNPACKED = 3;
/** An hour loaded before it closed (plus this, for the recorder to write it) is reloaded this often while shown. */
const HOUR_RELOAD_MS = 60_000;
/** A failed hour is retried after this. */
const HOUR_RETRY_MS = 30_000;
/** Timelines kept for recently shown snapshot sets: scrubbing back and forth near hour boundaries switches between them. */
const MAX_TIMELINES_CACHED = 4;
/** Without the live endpoint, service changes for today and yesterday are refetched this often (cheap: they come from our server, which polls TransLink on its own schedule). */
const CHANGES_REFRESH_MS = 60_000;
/** A version the live endpoint points to is retried no sooner than this after a failed fetch. */
const CHANGES_RETRY_MS = 10_000;
const MAX_CHANGE_DAYS_CACHED = 6;
/**
 * A profile's bands are loaded for the clock time and this far ahead of it, so the next band is in
 * by the time the clock reaches it.
 */
const PROFILE_PREFETCH_MS = 10 * 60_000;

export type RtMode =
  | "live"
  | "recorded"
  /** Recorded data covers the time but is still loading (schedule estimates meanwhile). */
  | "loading"
  | "estimated"
  | "unavailable";

interface DayChanges {
  data?: RtDayChanges;
  /** The version loaded, when it came from a live pointer. */
  version?: string | undefined;
  fetchedAt: number;
  loading: boolean;
}

interface HourChunk {
  /** "ready" stays while a reload is in flight: the snapshots loaded before still show. */
  status: "loading" | "ready" | "missing";
  packed?: PackedSnapshots | undefined;
  /** Epoch ms when the hour ends. */
  end: number;
  /** Epoch ms when the snapshots held were requested. */
  loadedAt: number;
  /** When a failed load may be retried (undefined: the hour isn't recorded). */
  retryAt?: number | undefined;
  /** Set while a load is in flight. */
  abort?: AbortController | undefined;
}

export class RtClient {
  private live: RtSnapshot[] = [];
  private liveError: string | undefined;
  /** Service changes versions from the live endpoint, while it's polled (service date → version). */
  private changesPointer: Record<string, VersionPointer> | undefined;
  /** Whether the live endpoint answered its last poll (until it fails, recent days wait for its pointer). */
  private liveOk = true;
  /** Recorded hours of the displayed day (hour id → chunk), packed (packages/transit-core/src/rt/packed.ts). */
  private hours = new Map<string, HourChunk>();
  /** Unpacked snapshots of recently shown hours, most recently used last. */
  private unpacked = new Map<string, RtSnapshot[]>();
  /** The displayed service day's [start, end], from update(). */
  private day: [number, number] | undefined;
  /** Whether to load every recorded hour of the day (set once the time is scrubbed). */
  private prefetching = false;
  /** prefetchDay() since the last update(): it applies to the day that update shows. */
  private prefetchRequested = false;
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
  private changes = new Map<ServiceDate, DayChanges>();
  /** Bumped whenever loaded service changes differ. */
  private changesVersion = 0;
  private view: { version: number; view: ChangesView } | undefined;
  private cancelledMemo = new Map<
    string,
    { version: number; corr: ScheduleCorrections | undefined }
  >();
  /**
   * Per feed version: its travel-time profile's bands (packages/transit-core/src/rt/profile-bands.ts),
   * as they're needed. Loaded bands stay: they're small, and scrubbing crosses them all.
   */
  private profiles = new Map<
    string,
    (RtBandProfile | "loading" | "missing")[]
  >();
  /** Bumped whenever a band of a profile loads. */
  private profileVersion = 0;
  /** Per feed version: its predictor, on the bands loaded when it was made. */
  private predictors = new Map<
    string,
    { predictor: Predictor; profileVersion: number }
  >();
  /** The clock time at the last update(): which bands of a profile to load. */
  private clockT = Date.now();
  private listeners = new Set<() => void>();
  available: boolean;
  /** The URL of a published file (PlanStore.dataUrl). */
  private readonly data: (path: string) => string;
  /** URL prefix of the RT service (undefined: schedules only). */
  private readonly api: string | undefined;
  /** URL prefix of the region on the RT service (…/regions/<id>/). */
  private readonly region: string | undefined;
  private readonly config: Pick<RegionConfig, "kinematics" | "rt" | "feed">;
  /** The feed whose vehicles these are: its live sections, history and changes. */
  private readonly feed: string;
  /** Thresholds that follow the feed's poll schedule (packages/transit-core/src/rt/budget.ts). */
  private readonly cadence: Cadence;
  private readonly prediction: PredictionConfig;

  constructor(
    urls: {
      data: (path: string) => string;
      api: string | undefined;
      region: string | undefined;
    },
    config: Pick<RegionConfig, "kinematics" | "rt" | "feed">,
  ) {
    const rt = config.feed.realtime;
    this.feed = config.feed.id;
    this.data = urls.data;
    this.api = rt ? urls.api : undefined;
    this.region = urls.region;
    this.config = config;
    this.cadence = rt ? cadence(rt) : NO_REALTIME;
    this.prediction = config.rt.prediction;
    this.available = this.api !== undefined;
    if (!this.available)
      this.liveError =
        rt ?
          "Real-time data isn't available on this site yet"
        : `${config.feed.name} publishes no real-time data`;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  /**
   * Called every frame with the clock time and the displayed service day's [start, end]; schedules
   * any fetches needed.
   */
  update(t: number, day: [number, number]): void {
    this.clockT = t;
    if (!this.api) return;
    this.setDay(day);
    if (this.prefetchRequested) {
      this.prefetching = true;
      this.prefetchRequested = false;
    }
    const nearNow = Math.abs(t - Date.now()) < LIVE_WINDOW_MS;
    if (!nearNow || t < Date.now() - this.cadence.maxInterpolateLimitS * 1000)
      this.ensureHours(t);
    if (this.available) this.ensureChanges(t, nearNow);
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

  /**
   * RT vehicles at t, or undefined when RT data doesn't cover t (use schedule estimates). Only
   * those `withDelay` accepts (vehicle ids; default every one) get a delay (RtTimeline.vehiclesAt).
   */
  vehiclesAt(
    t: number,
    pp: PreparedPlan | undefined,
    routes?: Set<string>,
    withDelay?: (id: string) => boolean,
  ): { mode: RtMode; vehicles?: VehicleState[] } {
    if (!this.available) return { mode: "unavailable" };
    const liveSpan = this.liveSpan();
    const inLive =
      liveSpan !== undefined
      && t >= liveSpan[0]
      && t <= liveSpan[1] + this.cadence.staleAfterMs(liveSpan[1]);
    const covered =
      inLive
      || coverageContains(this.coverage, t, this.cadence.coverageGapMs(t));
    if (!covered) return { mode: "estimated" };

    const snapshots = inLive ? this.live : this.snapshotsAround(t);
    if (!snapshots) return { mode: "loading" };
    return {
      mode: inLive ? "live" : "recorded",
      vehicles: this.timelineFor(snapshots, inLive, pp).vehiclesAt(
        t,
        routes,
        withDelay,
      ),
    };
  }

  private timelineFor(
    snapshots: RtSnapshot[],
    live: boolean,
    pp: PreparedPlan | undefined,
  ): RtTimeline {
    const predictor = pp ? this.predictorFor(pp) : undefined;
    // The prepared plan grows as its trip files load (PlanStore.planFor): its trip count is part of
    // the key, so vehicles are matched against every trip in so far.
    const key = `${live ? "live" : "rec"}:${snapshots.length}:${snapshots[0]?.fetchedAt}:${snapshots.at(-1)?.fetchedAt}:${pp?.plan.feedVersion}:${pp?.tripIndex.size}:${this.profileVersion}:${this.changesVersion}`;
    let timeline = this.timelines.get(key);
    if (timeline) this.timelines.delete(key);
    else {
      timeline = new RtTimeline(snapshots, pp, this.config.kinematics, {
        maxInterpolateS: this.cadence.maxInterpolateS,
        maxExtrapolateS: this.cadence.maxExtrapolateS,
        source: `${pp?.plan.agency ? `${pp.plan.agency} ` : ""}GTFS-RT ${live ? "live" : "recorded"}`,
        changes: this.changesView(),
        detourNearM: this.config.rt.detourNearM,
        ...(predictor ?
          { prediction: { cfg: this.prediction, predictor } }
        : {}),
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
   * fast-forwarding past the live edge), else recorded data covering t. Buses in `skip` (vehicle
   * ids) carry no delay: those drawn from RT at t, when no estimate of theirs is needed.
   */
  delayCorrections(
    t: number,
    pp: PreparedPlan | undefined,
    skip?: ReadonlySet<string>,
  ):
    | {
        byDate: Map<ServiceDate, ScheduleCorrections>;
        carried: Map<string, CarriedBus>;
      }
    | undefined {
    if (!this.available || !pp) return undefined;
    const fromLive = this.live.length > 0 && t >= this.live[0]!.fetchedAt;
    const recorded =
      (
        !fromLive
        && coverageContains(this.coverage, t, this.cadence.coverageGapMs(t))
      ) ?
        this.snapshotsAround(t)
      : undefined;
    const snapshots = fromLive ? this.live : recorded;
    if (!snapshots) return undefined;
    const delays = this.timelineFor(snapshots, fromLive, pp).tripDelays(
      t,
      skip,
    );
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
          this.config.rt.carry,
          this.changesView().cancelled,
        ),
      };
    }
    return this.carryMemo.result;
  }

  /** Trips TransLink cancelled on a service date, as corrections that hide their schedule estimates. */
  cancellationsFor(date: ServiceDate): ScheduleCorrections | undefined {
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
        view: changesView(days, this.cadence.alertGraceMs),
      };
    }
    return this.view.view;
  }

  /** Loads the service changes for the dates around t, refreshing recent ones. */
  private ensureChanges(t: number, nearNow: boolean): void {
    const now = Date.now();
    const today = localDate(t);
    const recentFrom = addDays(localDate(now), -1);
    for (const date of [addDays(today, -1), today]) {
      let e = this.changes.get(date);
      const pointer = this.changesPointer?.[date];
      if (pointer) {
        // Live: the version the live endpoint points to, an immutable file.
        if (
          e
          && (e.loading
            || e.version === pointer.version
            || now - e.fetchedAt < CHANGES_RETRY_MS)
        )
          continue;
      } else if (
        (e
          && (e.loading
            || date < recentFrom
            || now - e.fetchedAt < CHANGES_REFRESH_MS))
        // Live and the first response not in yet: it will point to the version to load.
        || (nearNow && this.liveOk && date >= recentFrom)
      )
        continue;
      if (!e) this.changes.set(date, (e = { fetchedAt: 0, loading: false }));
      const entry = e;
      entry.loading = true;
      entry.fetchedAt = now;
      void fetch(
        pointer ?
          `${this.api}${pointer.path}`
        : `${this.region}days/${date}/${this.feed}/changes`,
      )
        .then((r) => (r.ok ? (r.json() as Promise<RtDayChanges>) : undefined))
        .catch(() => undefined)
        .then((data) => {
          entry.loading = false;
          if (!data) return;
          entry.version = pointer?.version;
          if (JSON.stringify(data) === JSON.stringify(entry.data)) return;
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

  /**
   * Profile-based predictor for a feed. Bands of the profile not loaded yet fall back to the
   * timetable; it loads those the clock needs, and a new predictor takes over as each arrives.
   */
  predictorFor(pp: PreparedPlan): Predictor {
    const version = pp.plan.feedVersion;
    // Scenario plans ("<version>~<name>") share the base feed's profile.
    const base = version.split("~")[0]!;
    let bands = this.profiles.get(base);
    if (!bands) this.profiles.set(base, (bands = []));
    for (const t of [this.clockT, this.clockT + PROFILE_PREFETCH_MS]) {
      const band = bandOf(
        this.prediction.bandStartHours,
        toWallTime(t, pp.plan.timezone).hour,
      );
      if (!bands[band]) {
        bands[band] = "loading";
        void this.loadBand(pp.plan.feed, base, band, bands);
      }
    }
    let p = this.predictors.get(version);
    if (p?.profileVersion !== this.profileVersion) {
      const loaded = Array.from(bands, (b) =>
        typeof b === "object" ? b : undefined,
      );
      p = {
        profileVersion: this.profileVersion,
        predictor: new Predictor(pp, this.prediction, loaded, (date, tripId) =>
          this.changesView().skipped(date, tripId),
        ),
      };
      this.predictors.set(version, p);
    }
    return p.predictor;
  }

  private async loadBand(
    feed: string,
    version: string,
    band: number,
    bands: (RtBandProfile | "loading" | "missing")[],
  ): Promise<void> {
    const profile = await fetch(
      this.data(feedDataPath(feed, version, bandFileName(band))),
    )
      .then(async (r) =>
        r.ok ?
          decodeBandProfile(new Uint8Array(await r.arrayBuffer()))
        : undefined,
      )
      .catch(() => undefined);
    // A profile built with other bands than the site's (a deploy between the two) doesn't fit.
    const fits =
      profile?.band === band
      && profile.bandStartHours.join()
        === this.prediction.bandStartHours.join();
    bands[band] = fits ? profile : "missing";
    if (!fits) return;
    this.profileVersion++;
    this.emit();
  }

  liveStatus(): string | undefined {
    return this.liveError;
  }

  /** A new response from the live endpoint (live.ts): the latest snapshot and service changes versions. */
  acceptLive(r: LiveTransitResponse, receivedAt: number): void {
    if (!this.available) return;
    // This feed's sections (a region with several feeds has a pair per feed).
    const v = sectionOf(r, `${this.feed}/vehicles`, "vehicles");
    this.liveError = v?.error;
    this.liveOk = true;
    this.changesPointer = sectionOf(
      r,
      `${this.feed}/changes`,
      "changes",
    )?.versions;
    if (v?.status === "ok" && v.data) {
      const snapshot = expandSnapshot(v.data);
      const s: RtSnapshot = {
        ...snapshot,
        receivedAt: Math.max(receivedAt, snapshot.fetchedAt),
      };
      if (!this.live.length || s.fetchedAt > this.live.at(-1)!.fetchedAt) {
        this.live.push(s);
        const cutoff = Date.now() - LIVE_BUFFER_MS;
        while (this.live.length > 2 && this.live[0]!.fetchedAt < cutoff)
          this.live.shift();
      }
    }
    this.emit();
  }

  /** The live endpoint failed; `missing` when there is none (no real-time data at all). */
  liveFailed(error: string, missing: boolean): void {
    if (missing) this.available = false;
    this.liveError = error;
    this.liveOk = false;
    this.emit();
  }

  /** The live endpoint is no longer polled: its pointers would go stale. */
  liveStopped(): void {
    this.changesPointer = undefined;
  }

  // --- live ---

  private liveSpan(): [number, number] | undefined {
    // A feed answering without vehicles is an outage, not "no buses": it ends the live span like a
    // feed that stopped answering, so buses fall back to schedule estimates
    // (apps/server/src/rt/recorder.ts, emptyIsGap).
    const last = this.live.findLast((s) => s.vehicles.length > 0);
    if (
      !last
      || Date.now() - last.fetchedAt > this.cadence.staleAfterMs(last.fetchedAt)
    )
      return undefined;
    return [this.live[0]!.fetchedAt, last.fetchedAt];
  }

  // --- recorded history ---

  private hourId(t: number): { id: string; date: string; hour: string } {
    const w = toWallTime(t);
    const date = `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`;
    const hour = String(w.hour).padStart(2, "0");
    return { id: `${date}T${hour}`, date, hour };
  }

  /** Epoch ms of the end of the hour containing t. */
  private hourEnd(t: number): number {
    const w = toWallTime(t);
    return fromWallTime({ ...w, minute: 0, second: 0 }) + 3600_000;
  }

  /**
   * The displayed service day (the slider's range): hours kept loaded are those around it, so a
   * different day drops the others.
   */
  private setDay(day: [number, number]): void {
    if (this.day?.[0] === day[0] && this.day[1] === day[1]) return;
    this.day = day;
    this.prefetching = false;
    const margin = this.cadence.maxInterpolateLimitS * 1000;
    for (const [id, chunk] of this.hours)
      if (
        chunk.end <= day[0] - margin
        || chunk.end - 3600_000 >= day[1] + margin
      ) {
        chunk.abort?.abort();
        this.hours.delete(id);
        this.unpacked.delete(id);
      }
  }

  /** Load every recorded hour of the displayed day from now on (the time is being scrubbed). */
  prefetchDay(): void {
    this.prefetchRequested = true;
  }

  /**
   * Load the hour containing t, plus the neighbouring hour when t is near a boundary; while
   * prefetching, the rest of the day's recorded hours too, nearest first.
   */
  private ensureHours(t: number): void {
    const now = Date.now();
    const margin = this.cadence.maxInterpolateLimitS * 1000;
    // Hour id → a time in it; the hours shown first, the one containing t leading.
    const shown = new Map<string, number>();
    if (coverageContains(this.coverage, t, 15 * 60_000))
      for (const x of [t, t - margin, t + margin]) {
        const { id } = this.hourId(x);
        if (!shown.has(id)) shown.set(id, x);
      }
    const rest = new Map<string, number>();
    if (this.prefetching && this.day) {
      const starts: number[] = [];
      const end = Math.min(this.day[1], now);
      for (let x = this.hourEnd(this.day[0]) - 3600_000; x < end; x += 3600_000)
        if (this.coverage.some(([a, b]) => a < x + 3600_000 && b >= x))
          starts.push(x);
      const mid = (x: number) => Math.abs(x + 1800_000 - t);
      starts.sort((a, b) => mid(a) - mid(b));
      for (const x of starts) {
        const { id } = this.hourId(x);
        if (!shown.has(id)) rest.set(id, x);
      }
    }
    let loading = 0;
    for (const chunk of this.hours.values()) if (chunk.abort) loading++;
    const own = shown.keys().next().value;
    for (const [hours, isShown] of [
      [shown, true],
      [rest, false],
    ] as const)
      for (const [id, x] of hours) {
        const chunk = this.hours.get(id);
        if (chunk && !this.needsLoad(chunk, now, isShown)) continue;
        // The hour containing t never waits for others to finish.
        if (id !== own && loading >= MAX_HOUR_LOADS) continue;
        loading++;
        const { date, hour } = this.hourId(x);
        const c: HourChunk = chunk ?? {
          status: "loading",
          end: this.hourEnd(x),
          loadedAt: 0,
        };
        this.hours.set(id, c);
        void this.loadHour(id, date, hour, c);
      }
  }

  /**
   * Whether to (re)load an hour: never loaded, a failed load due for a retry, or (while shown)
   * loaded before the recorder finished writing it.
   */
  private needsLoad(chunk: HourChunk, now: number, shown: boolean): boolean {
    if (chunk.abort) return false;
    if (chunk.retryAt !== undefined) return now >= chunk.retryAt;
    if (chunk.status === "missing") return false;
    return (
      shown
      && chunk.loadedAt < chunk.end + HOUR_RELOAD_MS
      && now - chunk.loadedAt >= HOUR_RELOAD_MS
    );
  }

  private async loadHour(
    id: string,
    date: string,
    hour: string,
    chunk: HourChunk,
  ): Promise<void> {
    const abort = new AbortController();
    chunk.abort = abort;
    const startedAt = Date.now();
    try {
      const res = await fetch(
        `${this.api}rt/history?feed=${this.feed}&date=${date}&hour=${hour}`,
        { signal: abort.signal },
      );
      if (!res.ok) {
        if (chunk.status === "loading") chunk.status = "missing";
        // The recorder may not have written an hour that's still open.
        if (res.status !== 404 || startedAt < chunk.end + HOUR_RELOAD_MS)
          chunk.retryAt = startedAt + HOUR_RETRY_MS;
        return;
      }
      const text = await res.text();
      const packer = new SnapshotPacker();
      for (const line of text.split("\n"))
        if (line) packer.add(JSON.parse(line) as CompactSnapshot);
      chunk.packed = packer.finish();
      chunk.status = "ready";
      chunk.loadedAt = startedAt;
      chunk.retryAt = undefined;
      this.unpacked.delete(id);
    } catch {
      if (abort.signal.aborted) return;
      if (chunk.status === "loading") chunk.status = "missing";
      chunk.retryAt = startedAt + HOUR_RETRY_MS;
    } finally {
      chunk.abort = undefined;
      this.emit();
    }
  }

  /** A loaded hour's snapshots, unpacked for the few hours around the time shown. */
  private hourSnapshots(id: string): RtSnapshot[] | undefined {
    const chunk = this.hours.get(id);
    if (chunk?.status !== "ready" || !chunk.packed) return undefined;
    let s = this.unpacked.get(id);
    if (s) this.unpacked.delete(id);
    else {
      s = unpackSnapshots(chunk.packed);
      if (this.unpacked.size >= MAX_HOURS_UNPACKED)
        this.unpacked.delete(this.unpacked.keys().next().value!);
    }
    this.unpacked.set(id, s);
    return s;
  }

  /**
   * Snapshots from loaded hours around t, or undefined while the hour containing t loads (or
   * failed and will be retried). A neighbouring hour still loading is left out until it arrives.
   */
  private snapshotsAround(t: number): RtSnapshot[] | undefined {
    const own = this.hours.get(this.hourId(t).id);
    if (
      !own
      || own.status === "loading"
      || (own.status === "missing" && own.retryAt !== undefined)
    )
      return undefined;
    const margin = this.cadence.maxInterpolateLimitS * 1000;
    const out: RtSnapshot[] = [];
    const seen = new Set<string>();
    for (const x of [t - margin, t, t + margin]) {
      const { id } = this.hourId(x);
      if (seen.has(id)) continue;
      seen.add(id);
      const snapshots = this.hourSnapshots(id);
      if (snapshots) out.push(...snapshots);
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
        `${this.api}rt/coverage?feed=${this.feed}&from=${Math.round(lo)}&to=${Math.round(hi)}`,
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
