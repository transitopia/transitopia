// The transit engine, mounted imperatively on a MapLibre map the host owns (packages/transit-map/README.md):
// clock → playback → WebGL each frame, without React. Hosts read a small snapshot store (throttled
// to a few updates a second, plus every discrete change) with useSyncExternalStore, and call the
// methods here for controls.

import { LngLat, type Map as MlMap } from "maplibre-gl";
import type { Theme } from "@transitopia/map-style/basemap.ts";
import { realtimeOf } from "@transitopia/shared/datasets.ts";
import {
  bandIndexPerHour,
  FREQUENCY_BANDS,
} from "@transitopia/shared/frequency.ts";
import { TrackGraph } from "@transitopia/transit-core/infra/graph.ts";
import type { InfraCollection } from "@transitopia/transit-core/infra/types.ts";
import type { LineGeometry } from "@transitopia/transit-core/infra/line-geometry.ts";
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
  type PlanRoute,
} from "@transitopia/transit-core/plan/types.ts";
import {
  firstBoarding,
  placeName,
  shortId,
} from "@transitopia/transit-core/plan/display.ts";
import type {
  PreparedPlan,
  ScheduleCorrections,
  VehicleState,
} from "@transitopia/transit-core/schedule/engine.ts";
import type { Departure } from "@transitopia/transit-core/schedule/departures.ts";
import {
  DAY_HOURS,
  dayTypes,
  hourlyMinutes,
  routeMinutes,
} from "@transitopia/transit-core/schedule/frequency.ts";
import { Clock } from "./clock.ts";
import {
  PlanStore,
  SERVICE_DAY_ROLLOVER_H,
  displayServiceDate,
  hubsOf,
  mergeCorrections,
} from "./plans.ts";
import {
  BUS_STOPS_SOURCE,
  BUS_TICKS_SOURCE,
  CORRIDORS_SOURCE,
  EXCHANGES_SOURCE,
  OVERVIEW_CORRIDORS_SOURCE,
  ROUTES_SOURCE,
  SELECTED_PLACE_RADIUS_PX,
  SELECTED_PLACE_SOURCE,
  STATIONS_SOURCE,
  VEHICLES_BEFORE_LAYER,
  addStaticLayers,
  applyRouteFilter,
  applyStopsVisibility,
  brandedRoutes,
  setFerryPair,
  setFocusRoute,
  setSelectedPlace,
} from "./layers/static.ts";
import { VehicleLayer } from "./layers/vehicles.ts";
import { BusFrequencyLayer } from "./layers/bus-frequency.ts";
import {
  DAY_WINDOW,
  type FrequencyWindow,
} from "@transitopia/transit-core/plan/bus-frequency.ts";
import {
  DEBUG_SOURCE,
  LINES_SOURCE,
  TRACKS_SOURCE,
  addTrackLayers,
  applyTrackFilter,
  loadPlatforms,
  loadLines,
  loadTracks,
  PICKABLE_TRACK_LAYERS,
  setDebugPlatforms,
} from "./layers/tracks.ts";
import { readUrl, writeUrl, type Place, type UrlState } from "./url.ts";
import {
  resolveSelect,
  selectKey,
  vehicleKey,
  vehicleOfKey,
  type SelectContext,
} from "./select.ts";
import { RtClient, type RtMode } from "./rt.ts";
import { AisClient } from "./ais.ts";
import { LivePoller } from "./live.ts";
import { sectionsOfKind } from "@transitopia/transit-core/rt/live.ts";
import {
  placeChoice,
  placeLocation,
  placeSnapshot,
  type PickChoice,
  type PickMenu,
  type PlaceGroup,
  type PlaceSnapshot,
  type RouteSnapshot,
} from "./places.ts";
import { loadPref, savePref } from "./prefs.ts";
import type { RegionConfig } from "./config.ts";

export type { Theme };
export type { RtMode };
export type { RegionConfig };
export { RATES } from "./clock.ts";

export interface TransitEngineOptions {
  /** URL prefix of the published data (…/data/feeds/<feed>/manifest.json), ending in "/". */
  dataBase: string;
  /** URL prefix of the RT service (…/regions/<id>/live/transit), ending in "/"; omit for schedules only. */
  apiBase?: string | undefined;
  /**
   * The region's id (region.json): the RT service serves its live data under /regions/<id>/, and
   * its published files (tracks, dispatch, observations, scenarios) are under data/regions/<id>/.
   */
  region: string;
  theme: Theme;
  /** Build a scenario's plans instead of the real network (?scenario=<name>). */
  scenario?: string | undefined;
  /** Segment ids and platform markers on the tracks (?debug=1). */
  debug?: boolean | undefined;
  /** Initial time, rate and selection; defaults to the current URL. */
  initial?: UrlState | undefined;
  /** Dataset registry id for routes whose plan doesn't name one (plans built before PlanRoute.dataset). */
  dataset?: string | undefined;
  /** The region's config and feed (kinematics, real time, and rail and SeaBus where it has them), checked. */
  config: RegionConfig;
}

export interface SelectedVehicle {
  id: string;
  /** Undefined when the vehicle isn't in service at the shown time. */
  vehicle: VehicleState | undefined;
  route: PlanRoute | undefined;
  /**
   * Its trip as a rider would name it: when and where it starts, and the trip id as its agency's
   * riders see it (packages/transit-core/src/plan/display.ts). Undefined when the trip isn't in the plan.
   */
  trip: { start: number; from: string; shortId: string } | undefined;
  /** Registry ids of the data behind it (@transitopia/shared/datasets.ts), for its card's credits. */
  datasets: string[];
}

export type { Place };
export type { Departure };
export type { PickChoice, PickMenu, PlaceGroup, PlaceSnapshot, RouteSnapshot };

/** A card to open: a vehicle's, or a place's (station, exchange, stop or route line). */
export type CardTarget = { vehicle: string } | { place: Place };

/** A kind of day in the shown feed, with the route's minutes between trips per hour (DAY_HOURS). */
export interface RouteDay {
  date: ServiceDate;
  label: string;
  hours: (number | undefined)[];
}

export { DAY_HOURS };

export interface TransitSnapshot {
  /** Shown instant, epoch ms (updated a few times a second while playing). */
  t: number;
  /** Displayed service date (YYYYMMDD) and its description ("Weekday", "Sunday/holiday", …). */
  serviceDate: ServiceDate;
  serviceLabel: string;
  playing: boolean;
  rate: number;
  live: boolean;
  /** The time slider's span for the displayed service day, epoch ms. */
  sliderRange: [number, number];
  /** First and last service dates with a timetable (YYYYMMDD). */
  dateRange: [string, string] | undefined;
  /** Where real bus positions exist within the slider span, epoch ms. */
  coverage: [number, number][];
  rt: { mode: RtMode; label: string; title: string };
  /** Service changes in effect at the shown time. */
  notices: string[];
  /** Service dates shown with a preview dispatch (unconfirmed corrections; ?preview=). */
  preview: string[];
  routes: PlanRoute[];
  hidden: ReadonlySet<string>;
  /** Station and bus stop markers and labels are drawn. */
  showStops: boolean;
  /** Only vehicles with real positions are drawn (estimates hidden). */
  liveOnly: boolean;
  /** The shown plan draws bus corridors (packages/transit-map/README.md#bus-corridors). */
  corridors: boolean;
  /** What corridor colours count: the hour from the shown time, or the day's average. */
  busFrequency: FrequencyWindow;
  /** The camera keeps the selected vehicle in view. */
  following: boolean;
  selected: SelectedVehicle | undefined;
  /** The selected station, stop or route line (exclusive with a selected vehicle). */
  place: PlaceSnapshot | RouteSnapshot | undefined;
  /** The title of the card `back()` returns to, when this one was opened from another card. */
  back: string | undefined;
  /** A tap near several things: what it might have meant, to choose from (`choose`). */
  pick: PickMenu | undefined;
  /** Registry ids (@transitopia/shared/datasets.ts) of the data drawn right now. */
  datasets: string[];
  scenario: { name: string; description: string } | undefined;
  /**
   * A `?select=` key this region's plan doesn't have (another region's feature, or one only the
   * resolver knows): the host can look it up (GET /features/<key>) and move the map there.
   */
  elsewhere: string | undefined;
}

const RT_BADGE: Record<RtMode, [string, string]> = {
  live: ["Buses: live", "Bus positions from real-time data"],
  recorded: [
    "Buses: recorded",
    "Bus positions replayed from recorded real-time data",
  ],
  loading: [
    "Buses: loading…",
    "Loading recorded bus positions: estimated from the schedule until they arrive",
  ],
  estimated: [
    "Buses: estimated",
    "No real-time data recorded for this time: bus positions estimated from the schedule",
  ],
  unavailable: [
    "Buses: estimated",
    "Real-time data unavailable: bus positions estimated from the schedule",
  ],
};

/**
 * Clock changes (a seek on every slider input while scrubbing) write the URL at most this often:
 * Safari throws after ~100 history.replaceState calls in 10 s.
 */
const URL_WRITE_THROTTLE_MS = 300;
/**
 * Tapping a vehicle follows it only at this speed or slower (|rate|): constant panning at 60×+ is
 * disorienting (docs: apps/web/README.md#follow; the 10× cutoff is a guess).
 */
const FOLLOW_MAX_RATE = 10;
/** Pan when the followed vehicle comes within this fraction of the visible area's edge. */
const REVEAL_EDGE_FRACTION = 0.15;
const REVEAL_PAN_MS = 600;
/** Starting to follow eases to the vehicle over this long; then it's held at the centre. */
const FOLLOW_START_MS = 500;
/** While following, a change in the chrome's padding eases to the new centre over at least this long. */
const PADDING_EASE_MS = 300;
/** A scroll zoom whose camera hasn't moved for this long is finished (see scrollZoomSettled). */
const SCROLL_ZOOM_SETTLED_MS = 50;
/** Snapshot refresh while playing (discrete changes publish immediately). */
const SNAPSHOT_INTERVAL_MS = 200;
/**
 * With the time, zoom and inputs unchanged (paused), vehicles are recomputed this often anyway:
 * some inputs age with wall-clock time and announce no change (live data going stale).
 */
const IDLE_RECOMPUTE_MS = 1000;
/** Sources the engine adds to the host's map (removed on dispose). */
const SOURCES = [
  ROUTES_SOURCE,
  CORRIDORS_SOURCE,
  OVERVIEW_CORRIDORS_SOURCE,
  SELECTED_PLACE_SOURCE,
  STATIONS_SOURCE,
  EXCHANGES_SOURCE,
  BUS_STOPS_SOURCE,
  BUS_TICKS_SOURCE,
  TRACKS_SOURCE,
  LINES_SOURCE,
  DEBUG_SOURCE,
];
/** A tapped place is brought into view after this long, once its card is up and measured. */
const REVEAL_DELAY_MS = 150;
/** Tap tolerance around stations and stops (px). */
const PLACE_PICK_PX = 8;
/** A tap's menu lists at most this many things (packages/transit-map/README.md#tap-menu). */
const MAX_PICK_CHOICES = 8;
const SLIDER_START_S = SERVICE_DAY_ROLLOVER_H * 3600;
const SLIDER_END_S = (24 + SERVICE_DAY_ROLLOVER_H) * 3600;

export class TransitEngine {
  readonly clock: Clock;
  readonly store: PlanStore;
  private readonly map: MlMap;
  private readonly rt: RtClient;
  private readonly ais: AisClient;
  private readonly live: LivePoller;
  private readonly vehicles: VehicleLayer;
  private readonly debug: boolean;
  private readonly defaultDataset: string | undefined;
  private theme: Theme;
  private hidden: Set<string>;
  private showStops: boolean;
  private liveOnly: boolean;
  private busFrequency: FrequencyWindow;
  private frequencyLayer: BusFrequencyLayer | undefined;
  private selectedId: string | undefined;
  /** The selected vehicle's route, once seen: computed even while its route is hidden. */
  private selectedRoute: string | undefined;
  private place: Place | undefined;
  private pick: PickMenu | undefined;
  /** When something was selected: bring it into view once its card is up (performance.now()). */
  private revealAt: number | undefined;
  /** Per feed and route: its day types and hourly frequencies (they don't change with the time). */
  private routeDayCache = new WeakMap<PreparedPlan, Map<string, RouteDay[]>>();
  /** Per feed, route and date: its day average (dayMinutes). */
  private dayMinutesCache = new WeakMap<
    PreparedPlan,
    Map<string, number | undefined>
  >();
  /** What the vehicle colours were last set for (syncVehicleColors). */
  private vehicleColorsFor: { pp: PreparedPlan; key: string } | undefined;
  /** The real-time corrections last applied, per service date (for departure times). */
  private lastCorrections: Map<ServiceDate, ScheduleCorrections> | undefined;
  private following = false;
  /** When the ease that starts (or re-aims) follow ends (performance.now()). */
  private followEaseEnds = 0;
  /** When the camera last moved (performance.now()). */
  private lastCameraMove = 0;
  /** Follow ended: drop the map padding it set, once the map stops moving (a drag may be under way). */
  private clearPaddingPending = false;
  /** Screen edges covered by the host's chrome (cards, time bar), px: follow keeps clear of them. */
  private viewPadding = { top: 0, right: 0, bottom: 0, left: 0 };
  private tracks: InfraCollection | undefined;
  /** Line centrelines and ribbons for drawing SkyTrain (lines.geojson). */
  private lines: LineGeometry | undefined;
  private shownFeed: PreparedPlan | undefined;
  /** The feed the engine shows (its vehicles' `rt` refs are in it). */
  private readonly feed: string;
  /** A `?select=` key waiting for the plan and its places file. */
  private pendingSelect: string | undefined;
  /** A `?select=` key this plan doesn't have (TransitSnapshot.elsewhere). */
  private elsewhere: string | undefined;
  /** False from a style swap until 'style.load': our layers are gone until then. */
  private styleReady = true;
  /** The SeaBus berth pair last applied to the map (re-applied after the style reloads). */
  private ferryPair: string | null | undefined;
  private lastVehicles: VehicleState[] = [];
  /** Cards `open()` came through, oldest first, each with its title for the back strip. */
  private trail: { target: CardTarget; label: string }[] = [];
  private describers = new Map<string, (d: ServiceDate) => ServiceDayInfo>();
  private snapshot: TransitSnapshot;
  private listeners = new Set<() => void>();
  private lastPublish = 0;
  /** Something the snapshot shows changed: publish it this frame. */
  private dirty = true;
  /** Something vehicles depend on changed since they were last computed (see frame()). */
  private inputsChanged = true;
  /** The clock time, zoom and performance.now() vehicles were last computed at. */
  private computedFor = { t: NaN, zoom: NaN, at: -Infinity };
  private lastCoverageUpdate = 0;
  private coverage: [number, number][] = [];
  private lastUrlWrite = 0;
  private urlTimer: ReturnType<typeof setTimeout> | undefined;
  private raf = 0;
  private disposed = false;
  private cleanups: (() => void)[] = [];

  static async create(
    map: MlMap,
    opts: TransitEngineOptions,
  ): Promise<TransitEngine> {
    const store = await PlanStore.load(
      opts.dataBase,
      opts.apiBase,
      opts.region,
      opts.config,
      opts.scenario,
    );
    return new TransitEngine(map, store, opts);
  }

  private constructor(
    map: MlMap,
    store: PlanStore,
    opts: TransitEngineOptions,
  ) {
    this.map = map;
    this.store = store;
    this.theme = opts.theme;
    this.debug = opts.debug ?? false;
    this.defaultDataset = opts.dataset;
    const range = store.range();
    if (!range)
      throw new Error(
        'The timetable manifest lists no feeds. Run "npm run data".',
      );

    const url = opts.initial ?? readUrl();
    if (url.preview) store.setPreview(url.preview);
    this.clock = new Clock(url.t ?? Date.now());
    this.clock.setBounds(range[0], range[1]);
    if (url.t === undefined && (Date.now() < range[0] || Date.now() > range[1]))
      this.clock.seek(range[0] + 8 * 3600_000);
    if (url.rate !== undefined) this.clock.setRate(url.rate);
    if (url.paused) this.clock.pause();
    this.feed = opts.config.feed.id;
    // A vehicle is selected at once; a place once its plan (and places file) is in.
    this.selectedId = url.select && vehicleOfKey(url.select, this.feed);
    if (this.selectedId === undefined) this.pendingSelect = url.select;
    this.hidden = new Set(loadPref<string[]>("hiddenRoutes", []));
    this.showStops = loadPref("showStops", true);
    this.liveOnly = loadPref("liveOnly", false);
    // "night" was a window once; it reads as "now".
    this.busFrequency =
      loadPref<string>("busFrequency", "now") === "day" ? "day" : "now";

    this.vehicles = new VehicleLayer(map, opts.config.kinematics.sizing);
    this.vehicles.selectedId = this.selectedId;
    const regionBase =
      opts.apiBase ? `${opts.apiBase}regions/${opts.region}/` : undefined;
    this.rt = new RtClient(
      {
        data: (path) => store.dataUrl(path),
        api: opts.apiBase,
        region: regionBase,
      },
      opts.config,
    );
    // One poll for every live source: buses, SeaBus AIS, service changes, live dispatch.
    this.live = new LivePoller(
      regionBase && `${regionBase}live/transit`,
      opts.config.rt,
      {
        onResponse: (r, receivedAt) => {
          this.rt.acceptLive(r, receivedAt);
          this.ais.acceptLive(r);
          store.setLiveDispatch(sectionsOfKind(r, "dispatch")[0]?.versions);
        },
        onError: (error, missing) => this.rt.liveFailed(error, missing),
        onStop: () => this.rt.liveStopped(),
      },
    );
    // SeaBus: AIS fixes anchor the timetable (packages/transit-core/DESIGN.md#seabus-ais).
    this.ais = new AisClient(regionBase, opts.config, () => this.live.fresh);
    // Schedule estimates for buses stop at stops, using the same travel-time profile as live prediction.
    store.pacerFor = (pp) => this.rt.predictorFor(pp)?.pacer;
    this.snapshot = this.buildSnapshot(this.clock.now());

    // Track infrastructure, in a region with track-level rail (optional even there: without it,
    // SkyTrain falls back to GTFS shapes).
    const tracksPath = store.tracksPath;
    const dataUrl = (path: string) => store.dataUrl(path);
    if (tracksPath)
      void loadTracks(dataUrl, tracksPath).then(async (t) => {
        if (this.disposed) return;
        this.tracks = t;
        if (t) store.setTrackGraph(TrackGraph.fromCollection(t));
        if (t) this.lines = await loadLines(dataUrl, tracksPath);
        if (this.disposed) return;
        this.syncStatic(true);
      });
    this.syncStatic(true);

    const onStyleLoad = () => {
      this.styleReady = true;
      this.ferryPair = undefined;
      this.syncStatic(true);
    };
    const onStyleData = () => {
      // A new style (theme switch) replaces our sources and layers; wait for it to load. Sources
      // removed from the loaded style (a previous engine disposed, e.g. for another region) aren't
      // a new style, and no style.load would follow.
      if (!map.getSource(ROUTES_SOURCE) && !map.isStyleLoaded())
        this.styleReady = false;
    };
    const onClick = (e: {
      point: { x: number; y: number };
      originalEvent: MouseEvent;
    }) => {
      // Near several things: ask which (packages/transit-map/README.md#tap-menu).
      const choices = this.choicesAt(e.point.x, e.point.y);
      if (choices.length > 1) {
        this.pick = {
          x: e.originalEvent.clientX,
          y: e.originalEvent.clientY,
          choices,
        };
        this.publish();
        return;
      }
      const v = this.vehicles.pickAt(e.point.x, e.point.y);
      if (v) {
        this.select(v.id, {
          follow: Math.abs(this.clock.rate) <= FOLLOW_MAX_RATE,
        });
        return;
      }
      const place = this.placeAt(e.point.x, e.point.y);
      if (place) this.selectPlace(place);
      else this.select(undefined);
    };
    // Dragging the map takes the camera back; zooming doesn't. Either closes a tap's menu.
    const onGesture = () => this.dismissPick();
    const onDragStart = () => {
      this.dismissPick();
      if (!this.following) return;
      this.setFollow(false);
      this.publish();
    };
    const onMouseMove = (e: { point: { x: number; y: number } }) => {
      map.getCanvas().style.cursor =
        (
          this.vehicles.pickAt(e.point.x, e.point.y)
          || this.placeAt(e.point.x, e.point.y)
        ) ?
          "pointer"
        : "";
    };
    map.on("style.load", onStyleLoad);
    map.on("styledata", onStyleData);
    map.on("click", onClick);
    map.on("mousemove", onMouseMove);
    const onMove = () => {
      this.lastCameraMove = performance.now();
    };
    map.on("dragstart", onDragStart);
    map.on("zoomstart", onGesture);
    map.on("rotatestart", onGesture);
    map.on("move", onMove);
    this.cleanups.push(() => {
      map.off("dragstart", onDragStart);
      map.off("zoomstart", onGesture);
      map.off("rotatestart", onGesture);
      map.off("move", onMove);
      map.off("style.load", onStyleLoad);
      map.off("styledata", onStyleData);
      map.off("click", onClick);
      map.off("mousemove", onMouseMove);
      map.getCanvas().style.cursor = "";
    });

    const invalidate = () => this.invalidate();
    this.cleanups.push(
      this.clock.subscribe(() => {
        this.invalidate();
        this.writeUrlSoon();
      }),
      store.onChange(() => {
        this.syncStatic();
        this.describers.clear();
        this.resolveSelection();
        this.invalidate();
      }),
      this.rt.onChange(invalidate),
      this.ais.onChange(invalidate),
    );

    this.raf = requestAnimationFrame(this.frame);
    this.resolveSelection();
  }

  // --- controls ---

  toggle(): void {
    this.clock.toggle();
  }

  setRate(rate: number): void {
    this.clock.setRate(rate);
  }

  goLive(): void {
    this.clock.goLive();
  }

  seek(t: number): void {
    this.clock.seek(t);
  }

  /** Jump to another service date at the same time of day. */
  seekDate(date: ServiceDate): void {
    const t = this.clock.now();
    const sec = (t - serviceDayStart(displayServiceDate(t))) / 1000;
    this.clock.seek(serviceDayStart(date) + sec * 1000);
  }

  /** Seconds since the start of the displayed service day (the slider's value). */
  seekServiceSeconds(sec: number): void {
    const d = displayServiceDate(this.clock.now());
    this.clock.seek(serviceDayStart(d) + sec * 1000);
  }

  setRoutesHidden(keys: readonly string[], hidden: boolean): void {
    this.hidden = new Set(this.hidden); // a new identity for the snapshot
    for (const key of keys) {
      if (hidden) this.hidden.add(key);
      else this.hidden.delete(key);
    }
    savePref("hiddenRoutes", [...this.hidden]);
    if (this.styleReady) {
      applyRouteFilter(this.map, this.hidden);
      applyTrackFilter(this.map, this.hidden);
    }
    this.publish();
  }

  setStopsShown(shown: boolean): void {
    this.showStops = shown;
    savePref("showStops", shown);
    if (this.styleReady) applyStopsVisibility(this.map, shown);
    this.publish();
  }

  /** What bus corridors and stops are coloured by: the hour from the shown time, or the day's average. */
  setBusFrequency(window: FrequencyWindow): void {
    this.busFrequency = window;
    savePref("busFrequency", window);
    this.publish();
  }

  /** Draw only vehicles with real positions (observed or interpolated), or every vehicle. */
  setLiveOnly(liveOnly: boolean): void {
    this.liveOnly = liveOnly;
    savePref("liveOnly", liveOnly);
    this.publish();
  }

  /**
   * Select a vehicle (or none). A new selection follows it only when asked (easing over from the
   * one followed before); closing, or choosing another vehicle without asking, stops following.
   * Forgets the cards `open()` came through.
   */
  select(id: string | undefined, opts?: { follow?: boolean }): void {
    this.trail = [];
    this.selectVehicle(id, opts);
  }

  /** Take one of the tap menu's choices (`snapshot.pick`). */
  choose(choice: PickChoice): void {
    this.pick = undefined;
    if (choice.kind === "vehicle")
      this.select(choice.id, {
        follow: Math.abs(this.clock.rate) <= FOLLOW_MAX_RATE,
      });
    else this.selectPlace(choice.place);
  }

  /** Close the tap menu without choosing. */
  dismissPick(): void {
    if (!this.pick) return;
    this.pick = undefined;
    this.publish();
  }

  /** Open a station's or stop's card (closing any vehicle's), forgetting the cards `open()` came through. */
  selectPlace(place: Place): void {
    this.trail = [];
    this.showPlace(place);
  }

  /**
   * Open another card from the one showing (a station's departure → its route, bay or vehicle), so
   * its back strip returns here; `from` is this card's title for that strip. A vehicle opened this
   * way is followed under the same rule as tapping it (apps/web/README.md#cross-references).
   */
  open(target: CardTarget, from: string): void {
    const here: CardTarget | undefined =
      this.selectedId !== undefined ? { vehicle: this.selectedId }
      : this.place ? { place: this.place }
      : undefined;
    if (here) this.trail.push({ target: here, label: from });
    this.show(target);
  }

  /** Back to the card the showing one was opened from. */
  back(): void {
    const prev = this.trail.pop();
    if (prev) this.show(prev.target);
  }

  private show(target: CardTarget): void {
    if ("place" in target) this.showPlace(target.place);
    else
      this.selectVehicle(target.vehicle, {
        follow: Math.abs(this.clock.rate) <= FOLLOW_MAX_RATE,
      });
  }

  private selectVehicle(
    id: string | undefined,
    opts?: { follow?: boolean },
  ): void {
    const changed = id !== this.selectedId;
    if (changed)
      this.selectedRoute = this.lastVehicles.find((v) => v.id === id)?.routeKey;
    const follow =
      changed ? id !== undefined && (opts?.follow ?? false) : this.following;
    if (id !== undefined && changed && !follow)
      this.revealAt = performance.now() + REVEAL_DELAY_MS;
    this.selectedId = this.vehicles.selectedId = id;
    // Already following: ease to the new vehicle rather than letting keepCentred jump there.
    if (changed && follow && this.following)
      this.easeToFollowed(FOLLOW_START_MS);
    else if (changed) this.setFollow(follow);
    this.place = undefined;
    this.pick = undefined;
    this.pendingSelect = this.elsewhere = undefined;
    this.syncPlaceHighlight();
    this.writeUrl();
    this.publish();
  }

  private showPlace(place: Place): void {
    this.pendingSelect = this.elsewhere = undefined;
    this.selectedId = this.vehicles.selectedId = undefined;
    this.selectedRoute = undefined;
    this.setFollow(false);
    this.place = place;
    this.pick = undefined;
    this.revealAt = performance.now() + REVEAL_DELAY_MS;
    this.syncPlaceHighlight();
    this.writeUrl();
    this.publish();
  }

  /** The station, exchange or stop drawn under a screen point, if any (stations win, then exchanges). */
  private placeAt(x: number, y: number): Place | undefined {
    const { map } = this;
    const layers = [
      "stations",
      "stations-label",
      "exchanges",
      "exchanges-label",
      "bus-stops",
      VEHICLES_BEFORE_LAYER,
    ].filter((id) => map.getLayer(id));
    if (!layers.length) return undefined;
    const d = PLACE_PICK_PX;
    const hits = map.queryRenderedFeatures(
      [
        [x - d, y - d],
        [x + d, y + d],
      ],
      { layers },
    );
    const station = hits.find((f) => f.layer.id.startsWith("stations"));
    if (station)
      return { kind: "station", id: String(station.properties["id"]) };
    const exchange = hits.find((f) => f.layer.id.startsWith("exchanges"));
    if (exchange)
      return { kind: "exchange", id: String(exchange.properties["id"]) };
    const stop = hits.find((f) => f.properties["stop"] !== undefined);
    if (stop) return { kind: "stop", id: String(stop.properties["stop"]) };
    return this.routeAt(x, y);
  }

  /**
   * Everything a tap at a screen point might have meant, within the selected place's ring: vehicles,
   * then stations, exchanges, stops and route lines. A stop is left out when its exchange or
   * station is in. A route line that a vehicle, station or stop in the list is on doesn't count
   * towards asking, so a tap on a bus or a stop along its route doesn't ask; once the menu is asked
   * for anyway, it's listed too.
   */
  private choicesAt(x: number, y: number): PickChoice[] {
    const { map } = this;
    const pp = this.shownFeed;
    if (!pp || !this.styleReady) return [];
    const r = SELECTED_PLACE_RADIUS_PX;
    const near = (f: { geometry: GeoJSON.Geometry }) => {
      if (f.geometry.type !== "Point") return false;
      const [lon, lat] = f.geometry.coordinates;
      const p = map.project([lon!, lat!]);
      return Math.hypot(p.x - x, p.y - y) <= r;
    };
    const covered = new Set<string>();
    const out: PickChoice[] = [];
    for (const v of this.vehicles.pickWithin(x, y, r)) {
      covered.add(v.routeKey);
      out.push({
        kind: "vehicle",
        id: v.id,
        vehicle: v,
        route: pp.routes.get(v.routeKey),
      });
    }
    const placeLayers = [
      "stations",
      "exchanges",
      "bus-stops",
      VEHICLES_BEFORE_LAYER,
    ].filter((id) => map.getLayer(id));
    const hits =
      placeLayers.length ?
        map
          .queryRenderedFeatures(
            [
              [x - r, y - r],
              [x + r, y + r],
            ],
            { layers: placeLayers },
          )
          .filter(near)
      : [];
    const found = new Map<string, Place>();
    for (const kind of ["station", "exchange", "stop"] as const)
      for (const f of hits) {
        const id =
          kind === "station" ?
            f.layer.id === "stations" ?
              f.properties["id"]
            : undefined
          : kind === "exchange" ?
            f.layer.id === "exchanges" ?
              f.properties["id"]
            : undefined
          : f.properties["stop"];
        if (id === undefined) continue;
        found.set(`${kind}:${id}`, { kind, id: String(id) });
        for (const k of String(f.properties["routes"] ?? "").split(","))
          if (k) covered.add(k);
      }
    // A station's or exchange's bays are on its card.
    for (const h of hubsOf(pp.plan))
      if (
        found.has(`exchange:${h.id}`)
        || (h.station !== undefined && found.has(`station:${h.station}`))
      )
        for (const b of h.bays) found.delete(`stop:${b}`);
    const routes = this.routesAt(x, y, r);
    const uncovered = routes.filter((key) => !covered.has(key));
    const asks = out.length + found.size + uncovered.length > 1;
    for (const key of asks ? routes : uncovered)
      found.set(`route:${key}`, { kind: "route", id: key });
    for (const place of found.values()) {
      const c = placeChoice(pp, place);
      if (c) out.push(c);
    }
    return out.slice(0, MAX_PICK_CHOICES);
  }

  /** The route line under a screen point (bus, ferry and rail lines, and SkyTrain track). */
  private routeAt(x: number, y: number): Place | undefined {
    const key = this.routesAt(x, y, PLACE_PICK_PX)[0];
    return key === undefined ? undefined : { kind: "route", id: key };
  }

  /** The keys of the route lines within `d` px of a screen point, topmost first. */
  private routesAt(x: number, y: number, d: number): string[] {
    const { map } = this;
    const layers = [
      "routes-bus",
      "routes-bus-limited",
      "corridors-brand",
      "corridors-overview-brand",
      // Regular routes, drawn as the corridors they share (packages/transit-map/README.md#bus-corridors).
      "corridors",
      "corridors-overview",
      "routes-shape",
      "routes-shape-inactive",
      "routes-skytrain",
      ...PICKABLE_TRACK_LAYERS,
    ].filter((id) => map.getLayer(id));
    const brands = this.shownFeed ? brandedRoutes(this.shownFeed.plan) : [];
    if (!layers.length) return [];
    const known = this.shownFeed?.routes;
    const out = new Set<string>();
    for (const f of map.queryRenderedFeatures(
      [
        [x - d, y - d],
        [x + d, y + d],
      ],
      { layers },
    )) {
      if (f.layer.id === "corridors" || f.layer.id === "corridors-overview") {
        for (const key of this.frequencyLayer?.routesOn(
          f.layer.source,
          Number(f.id),
        ) ?? [])
          if (known?.has(key) && !this.hidden.has(key)) out.add(key);
        continue;
      }
      // Corridors carry the route with its own colour drawn on them as feature state.
      const brand =
        f.layer.id.endsWith("-brand") ? f.state["brand"] : undefined;
      if (
        f.layer.id.endsWith("-brand")
        && !(typeof brand === "number" && brand >= 0)
      )
        continue;
      const key =
        typeof brand === "number" ?
          (brands[brand]?.key ?? "")
        : String(f.properties["route"] ?? f.properties["line"] ?? "");
      if (known?.has(key) && !this.hidden.has(key)) out.add(key);
    }
    return [...out];
  }

  /** Where the selected place is, for its highlight and "Centre on map". */
  private placePoint(): [number, number] | undefined {
    const pp = this.shownFeed;
    return pp && this.place ? placeLocation(pp, this.place) : undefined;
  }

  /** The route whose card is open, when the map draws it: the map dims every other route. */
  private focusRoute(): string | undefined {
    const id = this.place?.kind === "route" ? this.place.id : undefined;
    return id !== undefined && routeKeys(this.shownFeed).includes(id) ?
        id
      : undefined;
  }

  private syncPlaceHighlight(): void {
    this.vehicles.focusRoute = this.focusRoute();
    if (!this.styleReady || this.disposed) return;
    setSelectedPlace(this.map, this.placePoint());
    setFocusRoute(this.map, this.focusRoute());
  }

  /** Centre the map on the selected vehicle (or station or stop), in the part of the map the host's chrome leaves clear. */
  locateSelected(): void {
    if (this.place?.kind === "route") {
      this.fitRoute(this.place.id);
      return;
    }
    const v =
      this.lastVehicles.find((x) => x.id === this.selectedId)
      ?? (() => {
        const at = this.placePoint();
        return at && { lon: at[0], lat: at[1] };
      })();
    if (v)
      this.map.easeTo({
        center: [v.lon, v.lat],
        zoom: Math.max(this.map.getZoom(), 15),
        ...(this.following ?
          { padding: this.viewPadding }
        : { offset: this.paddingOffset() }),
        duration: 600,
      });
  }

  /**
   * Where the middle of the visible area is, relative to the map's centre (net of any padding the
   * map already has). An offset rather than MapLibre's `padding`, which persists and shifts the
   * centre written to the URL: only follow sets the map's padding, while it lasts.
   */
  private paddingOffset(): [number, number] {
    const p = this.viewPadding;
    const m = this.mapPadding();
    return [
      (p.left - m.left - (p.right - m.right)) / 2,
      (p.top - m.top - (p.bottom - m.bottom)) / 2,
    ];
  }

  /** Fit a route's lines into the area the host's chrome leaves clear. */
  private fitRoute(key: string): void {
    const plan = this.shownFeed?.plan;
    if (!plan) return;
    let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const p of plan.patterns)
      if (p.route === key)
        for (const [lon, lat] of plan.shapes[p.shape] ?? []) {
          w = Math.min(w, lon);
          e = Math.max(e, lon);
          s = Math.min(s, lat);
          n = Math.max(n, lat);
        }
    if (!Number.isFinite(w)) return;
    const pad = this.viewPadding;
    const margin = 40;
    this.map.fitBounds(
      [
        [w, s],
        [e, n],
      ],
      {
        padding: {
          top: pad.top + margin,
          right: pad.right + margin,
          bottom: pad.bottom + margin,
          left: pad.left + margin,
        },
        duration: 600,
      },
    );
  }

  /**
   * A route's hourly frequency for each kind of day in the shown feed, the shown date's kind first
   * (cached: it doesn't change with the time).
   */
  routeDays(key: string): RouteDay[] {
    const pp = this.shownFeed;
    if (!pp) return [];
    let byRoute = this.routeDayCache.get(pp);
    if (!byRoute) this.routeDayCache.set(pp, (byRoute = new Map()));
    const from = displayServiceDate(this.clock.now());
    const cacheKey = `${key}|${from}`;
    let days = byRoute.get(cacheKey);
    if (!days) {
      days = dayTypes(pp, from).map((d) => ({
        date: d.date,
        label: this.describeDate(d.date),
        hours: hourlyMinutes(pp, key, d.date),
      }));
      byRoute.set(cacheKey, days);
    }
    return days;
  }

  /**
   * A route's average minutes between trips over the day (DAY_WINDOW, as the map's "Day" bus
   * frequency) on the shown service date, in its busier direction; undefined when it doesn't run then.
   */
  dayMinutes(key: string): number | undefined {
    const pp = this.shownFeed;
    if (!pp) return undefined;
    let byRoute = this.dayMinutesCache.get(pp);
    if (!byRoute) this.dayMinutesCache.set(pp, (byRoute = new Map()));
    const date = displayServiceDate(this.clock.now());
    const cacheKey = `${key}|${date}`;
    if (!byRoute.has(cacheKey))
      byRoute.set(
        cacheKey,
        routeMinutes(
          pp,
          key,
          date,
          DAY_WINDOW.fromH * 3600,
          (DAY_WINDOW.toH - DAY_WINDOW.fromH) * 3600,
        ),
      );
    return byRoute.get(cacheKey);
  }

  /** Keep the selected vehicle at the centre of the view (or stop). */
  setFollowing(on: boolean): void {
    this.setFollow(on && this.selectedId !== undefined);
    if (this.following) this.locateSelected();
    this.publish();
  }

  /**
   * Start or stop following (apps/web/README.md#follow). While following, the map's padding is the
   * area the host's chrome leaves clear, so its centre is the visible centre, where the vehicle is
   * held; scroll and pinch zoom go around that centre instead of the pointer, and every frame of
   * them is re-centred on the vehicle (holdFollowed), so zooming keeps the vehicle where it is.
   */
  private setFollow(on: boolean): void {
    if (on === this.following) return;
    this.following = on;
    const { map } = this;
    const around = on ? { around: "center" as const } : undefined;
    if (map.scrollZoom.isEnabled()) map.scrollZoom.enable(around);
    if (map.touchZoomRotate.isEnabled()) map.touchZoomRotate.enable(around);
    map.setTransformCameraUpdate(on ? this.holdFollowed : null);
    if (on) {
      this.clearPaddingPending = false;
      this.easeToFollowed(FOLLOW_START_MS);
    } else this.clearPaddingPending = true;
  }

  /**
   * While following, a zoom gesture's camera updates are centred on the vehicle as it moves:
   * keepCentred can't jumpTo during one without cancelling it, so it would drift off and jump back
   * when the gesture ends. Eases (ours, keyboard zoom) are left alone.
   */
  private readonly holdFollowed = (): { center?: LngLat } => {
    const { map } = this;
    if (!map.scrollZoom.isActive() && !map.touchZoomRotate.isActive())
      return {};
    const v = this.lastVehicles.find((x) => x.id === this.selectedId);
    return v ? { center: new LngLat(v.lon, v.lat) } : {};
  };

  /**
   * A scroll zoom has stopped changing the camera but is still under way: MapLibre ends it 200 ms
   * after its last frame (ScrollZoomHandler's finish timeout), with no camera updates for
   * holdFollowed to centre meanwhile. Cutting that short with a jumpTo loses nothing; a pinch is
   * left alone, since the fingers may still be down.
   */
  private scrollZoomSettled(): boolean {
    const { map } = this;
    return (
      map.scrollZoom.isActive()
      && !map.touchZoomRotate.isActive()
      && performance.now() - this.lastCameraMove > SCROLL_ZOOM_SETTLED_MS
    );
  }

  /** Ease the followed vehicle to the centre of the area the host's chrome leaves clear. */
  private easeToFollowed(duration: number): void {
    const v = this.lastVehicles.find((x) => x.id === this.selectedId);
    if (!v) return;
    this.followEaseEnds = performance.now() + duration;
    this.map.easeTo({
      center: [v.lon, v.lat],
      padding: this.viewPadding,
      duration,
    });
  }

  /** The map's current padding, every side defined. */
  private mapPadding(): {
    top: number;
    right: number;
    bottom: number;
    left: number;
  } {
    const p = this.map.getPadding();
    return {
      top: p.top ?? 0,
      right: p.right ?? 0,
      bottom: p.bottom ?? 0,
      left: p.left ?? 0,
    };
  }

  /** Remove the map's padding without moving what's on screen. */
  private clearMapPadding(): void {
    const { map } = this;
    const pad = this.mapPadding();
    if (pad.top || pad.right || pad.bottom || pad.left) {
      const canvas = map.getCanvas();
      map.jumpTo({
        center: map.unproject([
          canvas.clientWidth / 2,
          canvas.clientHeight / 2,
        ]),
        padding: { top: 0, right: 0, bottom: 0, left: 0 },
      });
    }
    this.clearPaddingPending = false;
  }

  /**
   * The screen edges the host's chrome covers (px), so follow and centre keep clear of them. While
   * following, a change (a vehicle's card opening as follow starts, or resizing) eases to the new
   * centre, re-aiming the follow-start ease if it's still going, rather than leaving keepCentred to
   * jump there. Not during a user's zoom: easeTo would cancel it (keepCentred catches up after).
   */
  setViewPadding(p: {
    top: number;
    right: number;
    bottom: number;
    left: number;
  }): void {
    const old = this.viewPadding;
    this.viewPadding = p;
    if (
      !this.following
      || (p.top === old.top
        && p.right === old.right
        && p.bottom === old.bottom
        && p.left === old.left)
    )
      return;
    const left = this.followEaseEnds - performance.now();
    if (left > 0 || !this.map.isMoving())
      this.easeToFollowed(Math.max(left, PADDING_EASE_MS));
  }

  /**
   * Follow: hold the vehicle exactly at the centre of the visible area, every frame. Not while the
   * map is moving (an ease, or the user zooming: holdFollowed centres those frames), because jumpTo
   * would cancel it.
   */
  private keepCentred(): void {
    const { map } = this;
    const v = this.lastVehicles.find((x) => x.id === this.selectedId);
    if (!v) return; // between trips or out of service: wait for it
    if (map.isMoving() && !this.scrollZoomSettled()) return;
    const want = this.viewPadding;
    const have = this.mapPadding();
    const at = map.project([v.lon, v.lat]);
    const centre = map.project(map.getCenter());
    if (
      want.top === have.top
      && want.right === have.right
      && want.bottom === have.bottom
      && want.left === have.left
      && Math.hypot(at.x - centre.x, at.y - centre.y) < 0.25
    )
      return;
    map.jumpTo({ center: [v.lon, v.lat], padding: want });
  }

  /** Pan so a point is clear of the host's chrome, if it's near or under it. */
  private keepPointInView(v: { lon: number; lat: number }): void {
    const { map } = this;
    if (map.isMoving()) return;
    const { width, height } = map.getCanvas().getBoundingClientRect();
    const p = this.viewPadding;
    const w = width - p.left - p.right;
    const h = height - p.top - p.bottom;
    if (w <= 0 || h <= 0) return;
    const pt = map.project([v.lon, v.lat]);
    const mx = w * REVEAL_EDGE_FRACTION;
    const my = h * REVEAL_EDGE_FRACTION;
    if (
      pt.x < p.left + mx
      || pt.x > width - p.right - mx
      || pt.y < p.top + my
      || pt.y > height - p.bottom - my
    )
      map.easeTo({
        center: [v.lon, v.lat],
        offset: this.paddingOffset(),
        duration: REVEAL_PAN_MS,
      });
  }

  /**
   * Colours for a theme. Call before the host swaps the basemap style: the engine re-adds its
   * layers, in the new colours, when the new style loads.
   */
  setTheme(theme: Theme): void {
    this.theme = theme;
  }

  // --- snapshot store (useSyncExternalStore) ---

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): TransitSnapshot => this.snapshot;

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.setFollow(false);
    this.clearMapPadding();
    clearTimeout(this.urlTimer);
    for (const fn of this.cleanups) fn();
    this.live.stop();
    this.vehicles.detach();
    const style = this.map.getStyle();
    for (const layer of style?.layers ?? [])
      if ("source" in layer && SOURCES.includes(layer.source))
        this.map.removeLayer(layer.id);
    for (const s of SOURCES)
      if (this.map.getSource(s)) this.map.removeSource(s);
    this.listeners.clear();
  }

  // --- internals ---

  /** Data, the clock or the style changed: recompute vehicles and publish on the next frame. */
  private invalidate(): void {
    this.dirty = true;
    this.inputsChanged = true;
  }

  private publish(): void {
    this.snapshot = this.buildSnapshot(this.clock.now());
    this.lastPublish = performance.now();
    this.dirty = false;
    // Every control (selection, filters, follow) publishes, and vehicles may depend on it.
    this.inputsChanged = true;
    for (const fn of this.listeners) fn();
  }

  /**
   * What selection keys are resolved against: the shown plan and its places file (null while it
   * loads when `waitForPlaces` is false, so the key is a ref until the file is in).
   */
  private selectContext(waitForPlaces: boolean): SelectContext | undefined {
    const pp =
      this.shownFeed
      ?? this.store.planFor(displayServiceDate(this.clock.now()));
    if (!pp) return undefined;
    const places = this.store.placesFor(pp);
    if (places === undefined && waitForPlaces) return undefined;
    return {
      feed: this.feed,
      plan: pp.plan,
      hubs: hubsOf(pp.plan),
      places: places ?? null,
    };
  }

  /** Select what the URL's key names, once its plan and places file are in. */
  private resolveSelection(): void {
    const key = this.pendingSelect;
    if (key === undefined) {
      // The places file may have arrived: write the canonical key.
      if (this.place) this.writeUrl();
      return;
    }
    const ctx = this.selectContext(true);
    if (!ctx) return;
    this.pendingSelect = undefined;
    const r = resolveSelect(key, ctx);
    if (r === "elsewhere") {
      this.elsewhere = key;
      this.publish();
    } else if (!r) this.writeUrl();
    else if ("vehicle" in r) this.selectVehicle(r.vehicle);
    else this.showPlace(r.place);
  }

  /** The selection's key for the URL: canonical once it's resolved, else as given. */
  private selectionKey(): string | undefined {
    if (this.selectedId !== undefined)
      return vehicleKey(this.feed, this.selectedId);
    if (this.place) {
      const ctx = this.selectContext(false);
      return ctx && selectKey({ place: this.place }, ctx);
    }
    return this.pendingSelect ?? this.elsewhere;
  }

  private writeUrl(): void {
    if (!this.disposed) writeUrl(this.clock, this.selectionKey());
  }

  /** Writes the URL once a burst of clock changes settles (URL_WRITE_THROTTLE_MS). */
  private writeUrlSoon(): void {
    if (this.urlTimer !== undefined) return;
    this.urlTimer = setTimeout(() => {
      this.urlTimer = undefined;
      this.writeUrl();
    }, URL_WRITE_THROTTLE_MS);
  }

  private describeDate(date: ServiceDate): string {
    const feed = feedForDate(this.store.manifest, date);
    const pp = this.store.planFor(date);
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

  private sliderRange(t: number): [number, number] {
    const start = serviceDayStart(displayServiceDate(t));
    return [start + SLIDER_START_S * 1000, start + SLIDER_END_S * 1000];
  }

  private rtState: { mode: RtMode; label: string; title: string } = {
    mode: "unavailable",
    label: RT_BADGE.unavailable[0],
    title: RT_BADGE.unavailable[1],
  };
  private notices: string[] = [];
  private datasets: string[] = [];

  private buildSnapshot(t: number): TransitSnapshot {
    const serviceDate = displayServiceDate(t);
    const feeds = this.store.manifest.feeds;
    const selected =
      this.selectedId === undefined ?
        undefined
      : (() => {
          const v = this.lastVehicles.find((x) => x.id === this.selectedId);
          const route = v ? this.shownFeed?.routes.get(v.routeKey) : undefined;
          return {
            id: this.selectedId,
            vehicle: v,
            route,
            trip: v && this.tripSummary(v),
            datasets: this.datasetsOf([
              [route, v !== undefined && v.provenance !== "estimated"],
            ]),
          };
        })();
    const prev = this.snapshot as TransitSnapshot | undefined;
    const routes = this.shownFeed?.plan.routes ?? [];
    return {
      t,
      serviceDate,
      serviceLabel: this.describeDate(serviceDate),
      playing: this.clock.playing,
      rate: this.clock.rate,
      live: this.clock.isLive(),
      sliderRange: this.sliderRange(t),
      dateRange:
        feeds.length ?
          [
            feeds.map((x) => x.start).sort()[0]!,
            feeds
              .map((x) => x.end)
              .sort()
              .at(-1)!,
          ]
        : undefined,
      coverage: this.coverage,
      rt: this.rtState,
      notices: this.notices,
      preview: this.store.previewDates,
      // Stable identities, so React skips re-rendering the legend.
      routes: prev && sameRoutes(prev.routes, routes) ? prev.routes : routes,
      hidden: this.hidden,
      showStops: this.showStops,
      liveOnly: this.liveOnly,
      corridors: Boolean(this.shownFeed?.plan.corridors?.length),
      busFrequency: this.busFrequency,
      following: this.following,
      selected,
      place: this.placeSnapshot(t),
      back: this.trail.at(-1)?.label,
      pick: this.pick,
      datasets:
        prev && prev.datasets.join() === this.datasets.join() ?
          prev.datasets
        : this.datasets,
      scenario:
        this.store.scenario ?
          {
            name: this.store.scenario.name,
            description: this.store.scenario.description,
          }
        : undefined,
      elsewhere: this.elsewhere,
    };
  }

  /**
   * Departures from the selected place after the shown time, from the timetable shifted by the
   * real-time corrections the vehicles use (packages/transit-core/DESIGN.md#departures).
   */
  /** The selected vehicle's trip: where and when riders can first board it (epoch ms), and its short id. */
  private tripSummary(v: VehicleState): SelectedVehicle["trip"] {
    const pp = this.store.planFor(v.serviceDate);
    const pt = pp?.tripIndex.get(v.tripId);
    if (!pp || !pt) return undefined;
    const i = firstBoarding(pt.pattern);
    return {
      start: serviceDayStart(v.serviceDate) + pt.dep[i]! * 1000,
      from: placeName(pp.plan, pt.pattern.stops[i]!),
      shortId: shortId(pp.plan.tripIdPattern, v.tripId),
    };
  }

  private placeSnapshot(t: number): PlaceSnapshot | RouteSnapshot | undefined {
    const pp = this.shownFeed;
    if (!this.place || !pp) return undefined;
    return placeSnapshot(this.place, {
      pp,
      t,
      vehicles: this.lastVehicles,
      drawn: (v) =>
        !this.hidden.has(v.routeKey)
        && !(this.liveOnly && v.provenance === "estimated"),
      corrections: (d) => this.lastCorrections?.get(d),
      datasetsOf: (routes) => this.datasetsOf(routes),
    });
  }

  /** Static layers follow the feed of the displayed date. */
  private syncStatic(force = false): void {
    const { map, store } = this;
    const pp = store.planFor(displayServiceDate(this.clock.now()));
    if (!pp || !this.styleReady || this.disposed) return;
    if (pp === this.shownFeed && !force) return;
    this.shownFeed = pp;
    addStaticLayers(map, pp.plan, this.theme, this.hidden);
    applyStopsVisibility(map, this.showStops);
    if (!pp.plan.corridors?.length) this.frequencyLayer = undefined;
    else if (!this.frequencyLayer || this.frequencyLayer.plan !== pp.plan)
      this.frequencyLayer = new BusFrequencyLayer(pp.plan);
    this.frequencyLayer?.invalidate();
    this.syncPlaceHighlight();
    this.ferryPair = undefined;
    if (this.tracks && this.lines) {
      addTrackLayers(
        map,
        this.tracks,
        this.lines,
        pp.plan,
        this.theme,
        this.debug,
      );
      applyTrackFilter(map, this.hidden);
      // Tracks replace the GTFS SkyTrain shapes.
      for (const id of ["routes-skytrain", "routes-skytrain-casing"])
        if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "none");
      if (this.debug) {
        const plan = pp.plan;
        const tracks = this.tracks;
        void loadPlatforms(
          (path) => this.store.dataUrl(path),
          plan.feed,
          plan.feedVersion,
        ).then(
          (p) =>
            p
            && !this.disposed
            && setDebugPlatforms(
              map,
              TrackGraph.fromCollection(tracks),
              plan,
              p,
            ),
        );
      }
    }
    this.vehicles.attach();
    this.vehicles.setRouteColors(pp.plan.routes);
    this.vehicleColorsFor = undefined;
    this.invalidate();
  }

  /**
   * Vehicles in their route's colour on the map: its own, except a regular bus route, which has none
   * and takes the frequency band its corridors show (the map's window, "now" or "day"), in the
   * current theme (packages/transit-map/README.md#bus-corridors). Re-set when the feed, the theme or
   * the frequency layer's rates change; returns whether they did.
   */
  private syncVehicleColors(): boolean {
    const pp = this.shownFeed;
    if (!pp) return false;
    const freq = this.frequencyLayer;
    const key = `${freq?.version ?? -1}|${this.theme}`;
    if (this.vehicleColorsFor?.pp === pp && this.vehicleColorsFor.key === key)
      return false;
    this.vehicleColorsFor = { pp, key };
    const bands = FREQUENCY_BANDS.length;
    this.vehicles.setRouteColors(
      pp.plan.routes.map((r) => {
        if (r.mode !== "bus" || r.category !== "regular") return r;
        const perHour = freq?.routePerHour(r.key);
        if (perHour === undefined) return r;
        // A bus out when none start in the window (its last trip): the least frequent band.
        const band = bandIndexPerHour(perHour);
        return {
          key: r.key,
          color:
            FREQUENCY_BANDS[band < 0 ? bands - 1 : band]!.color[this.theme],
        };
      }),
    );
    return true;
  }

  private frame = (): void => {
    if (this.disposed) return;
    const { store, rt, clock, map } = this;
    const t = clock.now();
    // Scenarios are hypothetical: never mix in real bus positions.
    if (!store.scenario) {
      rt.update(t);
      this.live.update(t);
    }
    // Vehicles (and the map repaint their upload triggers) only when something they depend on
    // changed: the time, the zoom (minimum drawn sizes), or an input (data, selection, filters).
    // Paused, that's almost never; IDLE_RECOMPUTE_MS covers what ages with wall-clock time.
    const zoom = map.getZoom();
    const at = performance.now();
    if (
      this.inputsChanged
      || t !== this.computedFor.t
      || zoom !== this.computedFor.zoom
      || at - this.computedFor.at > IDLE_RECOMPUTE_MS
    ) {
      this.inputsChanged = false;
      this.computedFor = { t, zoom, at };
      this.computeVehicles(t);
    }
    if (performance.now() - this.lastCoverageUpdate > 1000) {
      this.lastCoverageUpdate = performance.now();
      const [lo, hi] = this.sliderRange(t);
      const next = rt.coverageFor(lo, hi);
      if (JSON.stringify(next) !== JSON.stringify(this.coverage)) {
        this.coverage = next;
        this.dirty = true;
      }
    }
    this.syncStatic();
    if (this.frequencyLayer && this.styleReady) {
      const date = displayServiceDate(t);
      this.frequencyLayer.update(
        map,
        date,
        (t - serviceDayStart(date)) / 1000,
        this.busFrequency,
        this.hidden,
        this.focusRoute(),
      );
    }
    if (this.syncVehicleColors()) this.inputsChanged = true;
    if (this.following && this.styleReady) this.keepCentred();
    else if (this.clearPaddingPending && !map.isMoving())
      this.clearMapPadding();
    if (this.revealAt !== undefined && performance.now() > this.revealAt) {
      this.revealAt = undefined;
      const at = this.placePoint();
      const v = this.lastVehicles.find((x) => x.id === this.selectedId);
      if (this.styleReady) {
        if (at) this.keepPointInView({ lon: at[0], lat: at[1] });
        else if (v) this.keepPointInView(v);
      }
    }

    const now = performance.now();
    if (
      this.dirty
      || (clock.playing && now - this.lastPublish > SNAPSHOT_INTERVAL_MS)
    )
      this.publish();
    // URL sync: periodically while playing away from live (discrete changes write immediately).
    if (now - this.lastUrlWrite > 2000 && clock.playing && !clock.isLive()) {
      this.lastUrlWrite = now;
      this.writeUrl();
    }
    this.raf = requestAnimationFrame(this.frame);
  };

  /** Every vehicle at t, the corrections and badges that go with them, drawn on the map. */
  private computeVehicles(t: number): void {
    const { store, rt, ais, map } = this;
    // Hidden routes aren't computed, except the selected vehicle's and the open route card's:
    // hiding a layer hides it from the map, but its cards stay true. Until the selected vehicle
    // has been seen, compute everything to find it.
    const keep = new Set<string>();
    if (this.selectedRoute) keep.add(this.selectedRoute);
    if (this.place?.kind === "route") keep.add(this.place.id);
    const visible =
      !this.hidden.size || (this.selectedId && !this.selectedRoute) ?
        undefined
      : new Set(
          routeKeys(this.shownFeed).filter(
            (k) => !this.hidden.has(k) || keep.has(k),
          ),
        );
    const pp = store.planFor(displayServiceDate(t));
    const live =
      store.scenario ?
        { mode: "estimated" as const, vehicles: undefined }
      : rt.vehiclesAt(t, pp, visible);
    // RT delays carried forward: schedule estimates continue from where buses really were.
    const carry = store.scenario ? undefined : rt.delayCorrections(t, pp);
    let byDate = carry?.byDate;
    let aisUsed = false;
    if (!store.scenario) {
      for (const date of [addDays(localDate(t), -1), localDate(t)]) {
        const dpp = store.planFor(date);
        const seabus = dpp && ais.correctionsFor(date, dpp, t);
        if (!seabus) continue;
        aisUsed = true;
        byDate = new Map(byDate);
        byDate.set(date, mergeCorrections(seabus, byDate.get(date))!);
      }
      // Bus trips TransLink cancelled: no schedule estimates for them.
      for (const date of [addDays(localDate(t), -1), localDate(t)]) {
        const cancelled = rt.cancellationsFor(date);
        if (!cancelled) continue;
        byDate = new Map(byDate);
        byDate.set(date, mergeCorrections(byDate.get(date), cancelled)!);
      }
    }
    const scheduled = store.vehiclesAt(t, visible, byDate);
    // SeaBus route lines: the berth pair in use on the day shown solid, the other dotted.
    const shownDate = displayServiceDate(t);
    const shownPp = store.planFor(shownDate);
    const ferry = shownPp?.plan.ferry;
    const pair =
      ferry ?
        (!store.scenario && ais.pairFor(shownDate, shownPp)) || ferry.default
      : null;
    if (pair !== this.ferryPair && this.styleReady) {
      this.ferryPair = pair;
      setFerryPair(map, pair ?? undefined);
    }
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
      this.lastVehicles = [
        ...scheduled.filter((v) => v.mode !== "bus"),
        ...live.vehicles,
        ...carried,
      ];
    } else this.lastVehicles = scheduled.map(asBus);
    if (this.selectedId)
      this.selectedRoute =
        this.lastVehicles.find((v) => v.id === this.selectedId)?.routeKey
        ?? this.selectedRoute;
    this.lastCorrections = byDate;

    const notices = store.scenario ? [] : store.noticesAt(t);
    if (notices.join("\n") !== this.notices.join("\n")) {
      this.notices = notices;
      this.dirty = true;
    }
    const [label, title] = RT_BADGE[live.mode];
    const fullTitle = rt.liveStatus() ? `${title} (${rt.liveStatus()})` : title;
    if (
      live.mode !== this.rtState.mode
      || label !== this.rtState.label
      || fullTitle !== this.rtState.title
    ) {
      this.rtState = { mode: live.mode, label, title: fullTitle };
      this.dirty = true;
    }
    this.datasets = this.datasetsDrawn(live.vehicles ?? [], aisUsed);

    if (this.styleReady)
      this.vehicles.update(
        // The selected vehicle stays, so its card (and follow) still point at something.
        this.lastVehicles.filter(
          (v) =>
            v.id === this.selectedId
            || (!this.hidden.has(v.routeKey)
              && !(this.liveOnly && v.provenance === "estimated")),
        ),
        this.theme === "dark",
      );
  }

  /**
   * The datasets behind routes: each route's schedule (the plan's, else the host's default), and its
   * provider's real-time data where `realtime` (real positions or predicted times are shown).
   */
  private datasetsOf(
    routes: Iterable<[PlanRoute | undefined, boolean]>,
  ): string[] {
    const out = new Set<string>();
    for (const [route, realtime] of routes) {
      const schedule = route?.dataset ?? this.defaultDataset;
      if (!route || !schedule) continue;
      out.add(schedule);
      const rt = realtime ? realtimeOf(schedule) : undefined;
      if (rt) out.add(rt);
    }
    return [...out];
  }

  /** What the map shows right now, for the attribution control (docs/DESIGN.md#attribution). */
  private datasetsDrawn(
    rtVehicles: readonly VehicleState[],
    aisUsed: boolean,
  ): string[] {
    const routes = this.shownFeed?.routes;
    const out = this.datasetsOf([
      ...routeKeys(this.shownFeed)
        .filter((k) => !this.hidden.has(k))
        .map((k): [PlanRoute | undefined, boolean] => [routes?.get(k), false]),
      ...this.lastVehicles.map((v): [PlanRoute | undefined, boolean] => [
        routes?.get(v.routeKey),
        false,
      ]),
      ...rtVehicles.map((v): [PlanRoute | undefined, boolean] => [
        routes?.get(v.routeKey),
        true,
      ]),
    ]);
    if (aisUsed) out.push("aisstream");
    // The track network is imported from OpenStreetMap plus our overrides; corrections are ours.
    if (this.tracks) out.push("osm", "transitopia");
    return out;
  }

  /** Debug handle for the console (window.transit). */
  debugHandle(): object {
    return {
      map: this.map,
      clock: this.clock,
      store: this.store,
      rt: this.rt,
      vehicles: () => this.lastVehicles,
    };
  }
}

function routeKeys(pp: PreparedPlan | undefined): string[] {
  return pp ? pp.plan.routes.map((r) => r.key) : [];
}

function sameRoutes(a: PlanRoute[], b: PlanRoute[]): boolean {
  return (
    a.length === b.length
    && a.every(
      (r, i) =>
        r.key === b[i]!.key
        && r.color === b[i]!.color
        && r.label === b[i]!.label,
    )
  );
}
