// One feed in the engine (packages/transit-map/README.md#feeds): its plans (plans.ts), real-time
// buses (rt.ts) and AIS (ais.ts) with its live endpoint's poll (live.ts), service dates in its own time zone, and its layers on the map: its
// plan's tiles and stops (static.ts), its corridors' frequency tiers (bus-frequency.ts) and its rail
// network's track (tracks.ts). The clock, the vehicle layer, the selection and the snapshot are the
// engine's, shared by every feed.

import type { Map as MlMap } from "maplibre-gl";
import type { Theme } from "@transitopia/map-style/basemap.ts";
import { bandIndex, FREQUENCY_BANDS } from "@transitopia/shared/frequency.ts";
import { TrackGraph } from "@transitopia/transit-core/infra/graph.ts";
import type { InfraCollection } from "@transitopia/transit-core/infra/types.ts";
import {
  addDays,
  localDate,
  serviceDayStart,
  type ServiceDate,
} from "@transitopia/transit-core/time.ts";
import {
  makeServiceDescriber,
  type ServiceDayInfo,
} from "@transitopia/transit-core/gtfs/describe.ts";
import {
  feedForDate,
  patternStarts,
} from "@transitopia/transit-core/plan/types.ts";
import type {
  PreparedPlan,
  ScheduleCorrections,
  VehicleState,
} from "@transitopia/transit-core/schedule/engine.ts";
import {
  onSegment,
  segmentHourly,
  segmentRanges,
  segmentStarts,
  segmentSteps,
  segmentStops,
  sharedSegment,
  startOffsets,
  type SharedSegment,
} from "@transitopia/transit-core/schedule/shared-segment.ts";
import {
  dayTypes,
  hourlyFrequency,
  regularWeekdays,
  routeFrequency,
  routeStarts,
  routeWeekdayWait,
  type Frequency,
  type FrequencyWindow,
} from "@transitopia/transit-core/schedule/frequency.ts";
import {
  routeGroups,
  type RouteGroup,
} from "@transitopia/transit-core/plan/route-groups.ts";
import type { BusHub } from "@transitopia/transit-core/plan/exchanges.ts";
import {
  PlanStore,
  displayServiceDate,
  hubsOf,
  mergeCorrections,
  placeOfStop,
} from "./plans.ts";
import { RtClient, type RtMode } from "./rt.ts";
import { AisClient } from "./ais.ts";
import { LivePoller } from "./live.ts";
import type { FeedConfig } from "./config.ts";
import { feedIds, type FeedIds } from "./layers/ids.ts";
import {
  addStaticLayers,
  applyRouteFilter,
  applyStopsVisibility,
  fadeColor,
  setFerryPair,
  setRouteColors,
} from "./layers/static.ts";
import {
  addTrackDebugLayers,
  addTrackLayers,
  applyTrackFilter,
  loadPlatforms,
  loadTracks,
  setDebugPlatforms,
  setRailFocus,
} from "./layers/tracks.ts";
import { BusFrequencyLayer, nowWindowStart } from "./layers/bus-frequency.ts";
import type { VehicleLayer } from "./layers/vehicles.ts";
import { sharedEnds, type Place } from "./url.ts";
import type { SegmentContext } from "./places.ts";

/** A kind of day in the feed, with how often the route runs in each hour (DAY_HOURS). */
export interface RouteDay {
  date: ServiceDate;
  label: string;
  hours: (Frequency | undefined)[];
}

/** A combined route in a prepared plan (`segmentInfo`). */
export interface SegmentInfo extends SegmentContext {
  segment: SharedSegment | undefined;
  /** Its stops (plan indices) and their ids, for the map's focus. */
  stops: Set<number>;
  stopIds: string[];
  /** The corridors it runs along, once its patterns' paths are in. */
  corridors:
    | { detailed: ReadonlySet<number>; overview: ReadonlySet<number> }
    | undefined;
  /** SkyTrain's line pieces (their feature ids in the plan's tiles) it runs along, once they're in. */
  rail: ReadonlySet<number> | undefined;
  /** The hubs (`hubsOf`) its places were worked out with. */
  hubs: BusHub[];
  /** Its `sharedDays`, by the date they're from. */
  days: Record<string, RouteDay[]>;
}

/** The feed's vehicles at an instant, and what goes with them (`FeedSlot.vehiclesAt`). */
export interface FeedVehicles {
  vehicles: VehicleState[];
  /** Where its buses' positions come from at that instant. */
  mode: RtMode;
  /** Its real-time vehicles drawn from real-time data (for credits). */
  live: VehicleState[];
  /** Whether AIS fixes moved any of its vessels. */
  aisUsed: boolean;
}

const NO_IDS: ReadonlySet<number> = new Set();

export class FeedSlot {
  readonly feed: string;
  readonly ids: FeedIds;
  readonly config: FeedConfig;
  /** The feed's time zone: its service dates and times of day. */
  readonly tz: string;
  readonly store: PlanStore;
  readonly rt: RtClient;
  readonly ais: AisClient;
  /** Its live endpoint's poll (GET /feeds/<id>/live): buses, service changes and AIS. */
  readonly live: LivePoller;
  /** The rail network's track, where the feed runs on one, once loaded. */
  tracks: InfraCollection | undefined;
  /** The plan its layers were last drawn for: the displayed date's, with the trips loaded so far. */
  shown: PreparedPlan | undefined;
  /** The stations' and exchanges' grouping its layers were drawn with (hubsOf). */
  shownHubs: BusHub[] | undefined;
  frequencyLayer: BusFrequencyLayer | undefined;
  /** Its routes (keys) whose every group is hidden. */
  hidden: ReadonlySet<string> = new Set();
  /** Its plan's tiles in view have loaded since its lines' source was (re)added. */
  linesReady = false;
  /** The ferry berth pair last applied to the map (re-applied after the style reloads). */
  ferryPair: string | null | undefined;
  /** The real-time corrections last applied, per service date (for departure times). */
  lastCorrections: Map<ServiceDate, ScheduleCorrections> | undefined;
  /** What route colours were last set for (syncRouteColors). */
  private routeColorsFor: { pp: PreparedPlan; key: string } | undefined;
  /** SkyTrain pieces last marked as on a combined route (`syncRailFocus`), and for what. */
  private railFocused: ReadonlySet<number> = NO_IDS;
  private railFocusFor: ReadonlySet<number> | undefined;
  /** Per plan and route: its day types and hourly frequencies (they don't change with the time). */
  private routeDayCache = new WeakMap<PreparedPlan, Map<string, RouteDay[]>>();
  /** Per plan and combined route (`Place` id): what its card and the map's focus need (`segmentInfo`). */
  private segmentCache = new WeakMap<PreparedPlan, Map<string, SegmentInfo>>();
  /** Per plan and route: its weekday figure, where the plan hasn't it (dayWait). */
  private dayWaitCache = new WeakMap<
    PreparedPlan,
    Map<string, number | undefined>
  >();
  /** Per plan: each route's groups (`routeGroups`). */
  private groupsCache = new WeakMap<
    PreparedPlan["plan"],
    ReadonlyMap<string, readonly RouteGroup[]>
  >();
  private describers = new Map<string, (d: ServiceDate) => ServiceDayInfo>();

  static async create(
    config: FeedConfig,
    urls: { dataBase: string; apiBase: string | undefined },
    scenario: string | undefined,
  ): Promise<FeedSlot> {
    const store = await PlanStore.load(
      urls.dataBase,
      urls.apiBase,
      config,
      scenario,
    );
    return new FeedSlot(config, store, urls);
  }

  private constructor(
    config: FeedConfig,
    store: PlanStore,
    urls: { apiBase: string | undefined },
  ) {
    this.feed = config.feed.id;
    this.ids = feedIds(this.feed);
    this.config = config;
    this.tz = config.feed.timezone;
    this.store = store;
    // The feed's live data and per-date files on the RT service (…/feeds/<id>/).
    const api =
      urls.apiBase && `${urls.apiBase}feeds/${encodeURIComponent(this.feed)}/`;
    this.rt = new RtClient(
      { data: (path) => store.dataUrl(path), api: urls.apiBase, feed: api },
      config,
    );
    // SeaBus: AIS fixes anchor the timetable (packages/transit-core/DESIGN.md#seabus-ais).
    this.ais = new AisClient(api, config, () => this.live.fresh);
    // Only a feed with live sources has a live endpoint to poll.
    const live = config.feed.realtime || config.feed.ais;
    this.live = new LivePoller(api && live && `${api}live`, config.rt, {
      onResponse: (r, receivedAt) => {
        this.rt.acceptLive(r, receivedAt);
        this.ais.acceptLive(r);
      },
      onError: (error, missing) => this.rt.liveFailed(error, missing),
      onStop: () => this.rt.liveStopped(),
    });
    // Schedule estimates for buses stop at stops, using the same travel-time profile as live prediction.
    store.pacerFor = (pp) => this.rt.predictorFor(pp).pacer;
  }

  /** The service date shown for an instant (displayServiceDate) in the feed's time zone. */
  displayDate(t: number): ServiceDate {
    return displayServiceDate(t, this.tz);
  }

  /** Epoch ms of a service date's reference point (serviceDayStart) in the feed's time zone. */
  dayStart(date: ServiceDate): number {
    return serviceDayStart(date, this.tz);
  }

  /**
   * Load the rail network's track, where the feed runs on one (optional even there: without it,
   * SkyTrain falls back to GTFS shapes); `then` runs once it's in.
   */
  loadTracks(then: () => void): void {
    const path = this.store.tracksPath;
    if (!path) return;
    void loadTracks((p) => this.store.dataUrl(p), path).then((t) => {
      this.tracks = t;
      if (t) this.store.setTrackGraph(TrackGraph.fromCollection(t));
      then();
    });
  }

  /** Its routes by group (`routeGroups`, with weekday figures from `dayWait`). */
  groupsOf(pp: PreparedPlan): ReadonlyMap<string, readonly RouteGroup[]> {
    let groups = this.groupsCache.get(pp.plan);
    if (!groups) {
      groups = new Map(
        pp.plan.routes.map((r) => [
          r.key,
          routeGroups(r, this.dayWait(pp, r.key)),
        ]),
      );
      this.groupsCache.set(pp.plan, groups);
    }
    return groups;
  }

  /**
   * Work out its hidden routes again (the groups or the shown plan changed), and filter its lines on
   * the map (when `map` is given: the style is ready). Returns whether they changed.
   */
  syncHidden(
    hiddenGroups: ReadonlySet<RouteGroup>,
    map: MlMap | undefined,
  ): boolean {
    const pp = this.shown;
    const groups = pp ? this.groupsOf(pp) : new Map<string, RouteGroup[]>();
    const hidden = new Set(
      [...groups]
        .filter(([, gs]) => gs.every((g) => hiddenGroups.has(g)))
        .map(([key]) => key),
    );
    if (
      hidden.size === this.hidden.size
      && [...hidden].every((k) => this.hidden.has(k))
    )
      return false;
    this.hidden = hidden;
    if (map) {
      applyRouteFilter(map, this.ids, this.hidden);
      applyTrackFilter(map, this.ids, this.hidden);
    }
    return true;
  }

  /**
   * A route's weekday figure (minutes, `PlanRoute.weekdayWait`: the median of each daytime hour's
   * worst wait on regular weekdays, as the map's "Day" bus frequency), worked out here for a plan
   * published without it; undefined when it doesn't run then.
   */
  dayWait(pp: PreparedPlan, key: string): number | undefined {
    const route = pp.routes.get(key);
    if (route?.weekdayWait !== undefined) return route.weekdayWait;
    let byRoute = this.dayWaitCache.get(pp);
    if (!byRoute) this.dayWaitCache.set(pp, (byRoute = new Map()));
    if (!byRoute.has(key)) {
      const { plan } = pp;
      byRoute.set(
        key,
        routeWeekdayWait(
          pp.servicesOn,
          regularWeekdays(pp.servicesOn, plan.feedStart, plan.feedEnd),
          routeStarts(plan, patternStarts(plan), key),
        ),
      );
    }
    return byRoute.get(key);
  }

  /**
   * A route's hourly frequency for each kind of day in the shown plan, the kind of the date shown at
   * t first (cached: it doesn't change with the time).
   */
  routeDays(key: string, t: number): RouteDay[] {
    const pp = this.shown;
    if (!pp) return [];
    let byRoute = this.routeDayCache.get(pp);
    if (!byRoute) this.routeDayCache.set(pp, (byRoute = new Map()));
    const from = this.displayDate(t);
    const cacheKey = `${key}|${from}`;
    let days = byRoute.get(cacheKey);
    if (!days) {
      days = dayTypes(pp, from).map((d) => ({
        date: d.date,
        label: this.describeDate(d.date),
        hours: hourlyFrequency(pp, key, d.date),
      }));
      byRoute.set(cacheKey, days);
    }
    return days;
  }

  /** A combined route's hourly frequency (its buses leaving its start), as `routeDays`. */
  sharedDays(info: SegmentInfo, t: number): RouteDay[] {
    const pp = this.shown;
    if (!pp || !info.segment) return [];
    const from = this.displayDate(t);
    return (info.days[from] ??= dayTypes(pp, from).map((d) => ({
      date: d.date,
      label: this.describeDate(d.date),
      hours: segmentHourly(pp.servicesOn, info.sources, d.date),
    })));
  }

  /** How a service date is described ("Weekday", "Sunday/holiday", …), from its feed version's calendar. */
  describeDate(date: ServiceDate): string {
    const feed = feedForDate(this.store.manifest, date);
    const pp = this.store.planFor(date, Infinity);
    if (!feed) return "No timetable for this date";
    if (!pp) return "…";
    let fn = this.describers.get(feed.version);
    if (!fn)
      this.describers.set(
        feed.version,
        (fn = makeServiceDescriber(
          pp.servicesOn,
          pp.plan.feedStart,
          pp.plan.feedEnd,
        )),
      );
    return fn(date).label;
  }

  /** The plan changed (or its places file arrived): calendars may describe dates differently. */
  clearDescribers(): void {
    this.describers.clear();
  }

  /**
   * A combined route in the shown plan (packages/transit-core/DESIGN.md#combined-routes): its
   * segment (undefined when no route runs it in this plan) and what the card and the map's focus
   * need of it, worked out once per prepared plan (its departures' offsets come from the trips
   * loaded) and, for its corridors, once the plan's corridor refs are in.
   */
  segmentInfo(place: Place): SegmentInfo | undefined {
    const pp = this.shown;
    if (!pp || place.kind !== "shared" || place.feed !== this.feed)
      return undefined;
    let byId = this.segmentCache.get(pp);
    if (!byId) this.segmentCache.set(pp, (byId = new Map()));
    // Its places are the hubs' (stations' bays, exchanges), which change when the places file arrives.
    const hubs = hubsOf(pp.plan);
    let info = byId.get(place.id);
    if (!info || info.hubs !== hubs) {
      const { from, to } = sharedEnds(place);
      const segment = sharedSegment(pp.plan, from, to, placeOfStop(pp.plan));
      const cumOf = (shape: string) => pp.shapeCum.get(shape);
      const ranges = segment ? segmentRanges(pp.plan, segment) : new Map();
      const stops =
        segment ? segmentStops(pp.plan, segment) : new Set<number>();
      const plan = pp.plan;
      info = {
        segment,
        routes: segment?.routes ?? [],
        sources:
          segment ?
            segmentStarts(
              segment,
              patternStarts(plan),
              startOffsets(segment, plan.trips),
            )
          : [],
        stops,
        stopIds: [...stops].map((i) => plan.stops[i]!.id),
        corridors: undefined,
        rail: undefined,
        hubs,
        days: {},
        onSegment: (v) => {
          if (v.feed !== this.feed) return false;
          const pattern = pp.tripIndex.get(v.tripId)?.pattern.id;
          return (
            pattern !== undefined
            && onSegment(plan, ranges, pattern, [v.lon, v.lat], cumOf)
          );
        },
      };
      byId.set(place.id, info);
    }
    // What it's drawn over, once its patterns' paths are in: corridors, and SkyTrain's line pieces.
    const seg = info.segment;
    if (seg && !info.corridors && pp.plan.corridorInfo) {
      const paths = this.store.patternPathsFor(pp, seg.routes);
      if (paths !== undefined)
        info.corridors = {
          detailed: segmentSteps(pp.plan, seg, (p) => paths?.get(p)?.detailed),
          overview: segmentSteps(pp.plan, seg, (p) => paths?.get(p)?.overview),
        };
    }
    if (seg && !info.rail) {
      const rail =
        seg.routes.some((r) => pp.routes.get(r)?.mode === "skytrain") ?
          this.store.railPathsFor(pp)
        : null;
      if (rail !== undefined)
        info.rail = segmentSteps(pp.plan, seg, (p) => rail?.get(p));
    }
    return info;
  }

  /**
   * Keep the combined route's SkyTrain pieces marked (`setRailFocus`): those of the last ones marked
   * it no longer has unmarked, and after the lines' source was re-created (`invalidateLines`),
   * every one marked again, since MapLibre keeps state by feature id across new data.
   */
  syncRailFocus(map: MlMap, want: ReadonlySet<number> = NO_IDS): void {
    if (want === this.railFocusFor) return;
    const was = this.railFocused;
    setRailFocus(
      map,
      this.ids,
      [...was].filter((id) => !want.has(id)),
      false,
    );
    setRailFocus(map, this.ids, want, true);
    this.railFocused = want;
    this.railFocusFor = want;
  }

  /**
   * Draw its static layers for the displayed date's plan: they need only its core and its tiles, so
   * they're drawn before its trips are in. The shown plan is the latest prepared one (with the trips
   * loaded so far); its layers are redrawn when the feed version changes, or with `force` (a new
   * style, its places file). Returns whether they were (re)drawn; undefined while its plan or tiles
   * aren't in.
   */
  drawStatic(
    map: MlMap,
    t: number,
    opts: {
      theme: Theme;
      force: boolean;
      hiddenGroups: ReadonlySet<RouteGroup>;
      showStops: boolean;
      debug: boolean;
      vehicles: VehicleLayer;
      isDisposed: () => boolean;
    },
  ): boolean | undefined {
    const { store, ids } = this;
    const pp = store.planFor(this.displayDate(t), Infinity);
    if (!pp) return undefined;
    const tiles = store.tilesUrl(pp);
    if (!tiles) return undefined;
    const same = pp.plan === this.shown?.plan;
    this.shown = pp;
    if (same && !opts.force) return false;
    if (!same) this.syncHidden(opts.hiddenGroups, map);
    this.routeColorsFor = undefined;
    // Start loading its places file, whose grouping replaces the plan's (syncHubs).
    store.placesFor(pp);
    this.shownHubs = hubsOf(pp.plan);
    if (addStaticLayers(map, ids, pp.plan, tiles, opts.theme, this.hidden))
      this.linesReady = false;
    applyStopsVisibility(map, ids, opts.showStops);
    if (!pp.plan.corridorInfo) this.frequencyLayer = undefined;
    else if (!this.frequencyLayer || this.frequencyLayer.plan !== pp.plan)
      this.frequencyLayer = new BusFrequencyLayer(pp.plan, ids);
    this.frequencyLayer?.invalidate(map);
    this.railFocusFor = undefined;
    this.ferryPair = undefined;
    // SkyTrain's track, in the tiles of a feed with track-level rail (they replace its GTFS shapes).
    addTrackLayers(map, ids, pp.plan, opts.theme);
    applyTrackFilter(map, ids, this.hidden);
    if (opts.debug && this.tracks) {
      addTrackDebugLayers(map, ids, this.tracks, opts.theme);
      const plan = pp.plan;
      const tracks = this.tracks;
      void loadPlatforms(
        (path) => store.dataUrl(path),
        plan.feed,
        plan.feedVersion,
      ).then(
        (p) =>
          p
          && !opts.isDisposed()
          && setDebugPlatforms(
            map,
            ids,
            TrackGraph.fromCollection(tracks),
            plan,
            p,
          ),
      );
    }
    opts.vehicles.setRouteColors(this.feed, pp.plan.routes);
    return true;
  }

  /** The routes' colours must be set again (a new style, or the brand colours switched). */
  invalidateRouteColors(): void {
    this.routeColorsFor = undefined;
  }

  /**
   * Its routes in their colour on the map: their own (`PlanRoute.brand`, while `showBrandColors` is
   * on), or the frequency band of the map's window ("now" or "day"), as their corridors show it, in
   * the current theme (packages/transit-map/README.md#bus-corridors): vehicles, and with brand
   * colours off, lines too (`setRouteColors`, when `map` is given: the style is ready). Re-set when
   * the plan, the theme, the choice, the window or the frequency layer's rates change; returns
   * whether they did.
   */
  syncRouteColors(
    map: MlMap | undefined,
    vehicles: VehicleLayer,
    opts: {
      t: number;
      theme: Theme;
      showBrandColors: boolean;
      window: FrequencyWindow;
    },
  ): boolean {
    const pp = this.shown;
    if (!pp) return false;
    const freq = this.frequencyLayer;
    const { t, theme, showBrandColors, window } = opts;
    const date = this.displayDate(t);
    const step =
      window === "now" ? nowWindowStart((t - this.dayStart(date)) / 1000) : 0;
    const key = `${freq?.version ?? -1}|${theme}|${showBrandColors}|${window}|${date}|${step}`;
    if (this.routeColorsFor?.pp === pp && this.routeColorsFor.key === key)
      return false;
    this.routeColorsFor = { pp, key };
    const colors: Record<string, string> = {};
    for (const r of pp.plan.routes) {
      if (r.brand && showBrandColors) continue;
      // Corridors' rates first: a bus out when none start in the window (its last trip) has
      // Infinity there, the last band.
      const wait =
        freq?.routeWait(r.key)
        ?? (window === "day" ?
          this.dayWait(pp, r.key)
        : routeFrequency(pp, r.key, date, step, 3600)?.wait);
      if (wait !== undefined)
        colors[r.key] = FREQUENCY_BANDS[bandIndex(wait)]!.color[theme];
    }
    vehicles.setRouteColors(
      this.feed,
      pp.plan.routes.map((r) => ({
        key: r.key,
        color: colors[r.key] ?? r.color,
      })),
    );
    if (map)
      setRouteColors(
        map,
        this.ids,
        showBrandColors ? undefined : colors,
        showBrandColors ? undefined : (
          Object.fromEntries(
            Object.entries(colors).map(([k, c]) => [k, fadeColor(c, theme)]),
          )
        ),
      );
    return true;
  }

  /**
   * Its vehicles at t: timetable vehicles and track-level SkyTrain (plans.ts) shifted by AIS, service
   * changes and real-time delays, and real-time buses where there are fixes (rt.ts). `visible` limits
   * which routes are computed (keys; undefined: all), and `selected` names its selected vehicle (by
   * its id), whose delay is always worked out. With `place`, a card needs every bus's delay (its
   * departure times), not only those of buses shown as estimates. A scenario mixes in no real data.
   */
  vehiclesAt(
    t: number,
    opts: {
      visible: Set<string> | undefined;
      selected: (id: string) => boolean;
      place: boolean;
      scenario: boolean;
    },
  ): FeedVehicles {
    const { store, rt, ais } = this;
    const { scenario } = opts;
    const pp = store.planFor(this.displayDate(t));
    const live =
      scenario ?
        { mode: "estimated" as const, vehicles: undefined }
      : rt.vehiclesAt(t, pp, opts.visible, opts.selected);
    // RT delays carried forward: schedule estimates continue from where buses really were. Of a
    // bus drawn from RT only a place card needs the delay (its departure times); the map draws an
    // estimate only for a bus that isn't (below), so the rest are left out.
    const carry =
      scenario ? undefined : (
        rt.delayCorrections(
          t,
          pp,
          live.vehicles && !opts.place ?
            new Set(live.vehicles.map((v) => v.id))
          : undefined,
        )
      );
    let byDate = carry?.byDate;
    let aisUsed = false;
    const today = localDate(t, this.tz);
    if (!scenario) {
      for (const date of [addDays(today, -1), today]) {
        // The day before: only its trips still running.
        const dpp = store.planFor(
          date,
          date === today ? 0 : (t - this.dayStart(date)) / 1000,
        );
        const seabus = dpp && ais.correctionsFor(date, dpp, t);
        if (!seabus) continue;
        aisUsed = true;
        byDate = new Map(byDate);
        byDate.set(date, mergeCorrections(seabus, byDate.get(date))!);
      }
      // Bus trips TransLink cancelled: no schedule estimates for them.
      for (const date of [addDays(today, -1), today]) {
        const cancelled = rt.cancellationsFor(date);
        if (!cancelled) continue;
        byDate = new Map(byDate);
        byDate.set(date, mergeCorrections(byDate.get(date), cancelled)!);
      }
    }
    const scheduled = store.vehiclesAt(t, opts.visible, byDate);
    // An estimate carrying a bus's RT delay stands for that bus: it keeps the RT vehicle's id and
    // number, so a selection (or follow) carries across the hand-over, and back at the next fix.
    const shownIds = new Set(live.vehicles?.map((v) => v.id));
    const asBus = (v: VehicleState): VehicleState => {
      const bus = v.mode === "bus" ? carry?.carried.get(v.tripId) : undefined;
      if (!bus || shownIds.has(bus.id)) return v;
      shownIds.add(bus.id);
      const est: VehicleState = { ...v, id: bus.id };
      if (bus.label) est.label = bus.label;
      return est;
    };
    let vehicles: VehicleState[];
    if (live.vehicles) {
      // RT buses, plus estimates for buses whose RT prediction has run out (unreported for a while)
      // but whose delay is known, unless the same bus (block) is already shown from RT.
      const shownBlocks = new Set(
        live.vehicles.map((v) => pp?.tripIndex.get(v.tripId)?.vehicleId),
      );
      const carried = scheduled
        .filter(
          (v) =>
            v.mode === "bus"
            && carry?.carried.has(v.tripId)
            && !shownBlocks.has(v.id),
        )
        .map(asBus)
        .filter((v) => v.id.startsWith("rt:"));
      vehicles = [
        ...scheduled.filter((v) => v.mode !== "bus"),
        ...live.vehicles,
        ...carried,
      ];
    } else vehicles = scheduled.map(asBus);
    this.lastCorrections = byDate;
    return {
      vehicles,
      mode: live.mode,
      live: live.vehicles ?? [],
      aisUsed,
    };
  }

  /**
   * SeaBus route lines: the berth pair in use on the day shown at t solid, the other dotted (set on
   * the map when it changes, and `map` is given: the style is ready).
   */
  syncFerryPair(map: MlMap | undefined, t: number, scenario: boolean): void {
    const date = this.displayDate(t);
    const pp = this.store.planFor(date);
    const ferry = pp?.plan.ferry;
    const pair =
      ferry ? (!scenario && this.ais.pairFor(date, pp)) || ferry.default : null;
    if (pair !== this.ferryPair && map) {
      this.ferryPair = pair;
      setFerryPair(map, this.ids, pair ?? undefined);
    }
  }
}
