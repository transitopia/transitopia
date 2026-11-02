// The transit engine, mounted imperatively on a MapLibre map the host owns (packages/transit-map/README.md):
// clock → playback → WebGL each frame, without React. Hosts read a small snapshot store (throttled
// to a few updates a second, plus every discrete change) with useSyncExternalStore, and call the
// methods here for controls.

import { LngLat, type Map as MlMap } from "maplibre-gl";
import type { Theme } from "@transitopia/map-style/basemap.ts";
import { CardTrail } from "@transitopia/shared/card-trail.ts";
import { realtimeOf } from "@transitopia/shared/datasets.ts";
import type { ServiceDate } from "@transitopia/transit-core/time.ts";
import type { PlanRoute } from "@transitopia/transit-core/plan/types.ts";
import {
  firstBoarding,
  placeName,
  shortId,
} from "@transitopia/transit-core/plan/display.ts";
import type { VehicleState } from "@transitopia/transit-core/schedule/engine.ts";
import type { Departure } from "@transitopia/transit-core/schedule/departures.ts";
import { segmentLines } from "@transitopia/transit-core/schedule/shared-segment.ts";
import type { LonLat } from "@transitopia/transit-core/geo.ts";
import {
  DAY_HOURS,
  type Frequency,
  type FrequencyWindow,
} from "@transitopia/transit-core/schedule/frequency.ts";
import {
  ROUTE_GROUPS,
  type RouteGroup,
} from "@transitopia/transit-core/plan/route-groups.ts";
import { Clock } from "./clock.ts";
import { SERVICE_DAY_ROLLOVER_H, displayServiceDate, hubsOf } from "./plans.ts";
import {
  PLACE_LAYERS,
  SEGMENT_FOCUS,
  SELECTED_PLACE_RADIUS_PX,
  SELECTED_PLACE_SOURCE,
  applyStopsVisibility,
  VEHICLES_BEFORE_LAYER,
  removeSources,
  setFocus,
  setSelectedPlace,
} from "./layers/static.ts";
import { applyBrandColors } from "./overview.ts";
import { VehicleLayer } from "./layers/vehicles.ts";
import { metresPerPixel } from "./layers/vehicle-geometry.ts";
import { nowWindowStart, type Focus } from "./layers/bus-frequency.ts";
import { PICKABLE_TRACK_LAYERS } from "./layers/tracks.ts";
import { firstFeedLayer } from "./layers/order.ts";
import {
  brandedRoutes,
  PLAN_TILE_LAYERS,
} from "@transitopia/transit-core/plan/tiles.ts";
import { readUrl, writeUrl, type Place, type UrlState } from "./url.ts";
import {
  resolveSelect,
  selectKey,
  vehicleKey,
  vehicleOfKey,
  type SelectContext,
} from "./select.ts";
import type { RtMode } from "./rt.ts";
import { LivePoller } from "./live.ts";
import { sectionOf } from "@transitopia/transit-core/rt/live.ts";
import {
  placeChoice,
  placeLocation,
  placeSnapshot,
  type PickChoice,
  type PickMenu,
  type PlaceGroup,
  type PlaceSnapshot,
  type RouteSnapshot,
  type SharedSnapshot,
} from "./places.ts";
import { loadPref, savePref } from "./prefs.ts";
import type { FeedConfig } from "./config.ts";
import {
  FeedSlot,
  type FeedVehicles,
  type RouteDay,
  type SegmentInfo,
} from "./feed-slot.ts";
import { feedKey, routeId, splitFeedKey, vehicleId } from "./keys.ts";

export type { Theme };
export type { RtMode };
export type { FeedConfig };
export type { RouteDay };
export { routeId, vehicleId };
export { RATES } from "./clock.ts";

export interface TransitEngineOptions {
  /** URL prefix of the published data (…/data/feeds/<feed>/manifest.json), ending in "/". */
  dataBase: string;
  /** URL prefix of the RT service (…/feeds/<id>/live), ending in "/"; omit for schedules only. */
  apiBase?: string | undefined;
  theme: Theme;
  /** Build a scenario's plans instead of the real network (?scenario=<name>). */
  scenario?: string | undefined;
  /** Segment ids and platform markers on the tracks (?debug=1). */
  debug?: boolean | undefined;
  /** Initial time, rate and selection; defaults to the current URL. */
  initial?: UrlState | undefined;
  /**
   * The feeds shown, each with its config (kinematics, real time, and rail and SeaBus where it has
   * them), checked: one slot each (packages/transit-map/README.md#feeds). The first one's time zone
   * is the clock's.
   */
  feeds: readonly FeedConfig[];
  /**
   * Called once when the published data has been rebuilt since the engine started and its files
   * can no longer be loaded (`PlanStore.rebuilt`): the host disposes of the engine and makes a new
   * one, which starts from the URL (time and selection, written just before).
   */
  onRebuilt?: (() => void) | undefined;
}

export interface SelectedVehicle {
  /** Its id across feeds (`vehicleId`). */
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
export type {
  PickChoice,
  PickMenu,
  PlaceGroup,
  PlaceSnapshot,
  RouteSnapshot,
  SharedSnapshot,
};

/** A card to open: a vehicle's, or a place's (station, exchange, stop or route line). */
export type CardTarget = { vehicle: string } | { place: Place };

export { DAY_HOURS };
export type { Frequency };

export interface TransitSnapshot {
  /** Shown instant, epoch ms (updated a few times a second while playing). */
  t: number;
  /** The time zone times are shown in (the first feed's, TransitEngineOptions.feeds). */
  timezone: string;
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
  /** Every feed's routes. */
  routes: PlanRoute[];
  /** Each route's groups (the layers panel's switches, `routeGroups`), by `routeId`. */
  groups: ReadonlyMap<string, readonly RouteGroup[]>;
  /** Groups switched off: their routes are hidden unless another of their groups is on. */
  hiddenGroups: ReadonlySet<RouteGroup>;
  /** Routes not drawn (`routeId`s): those whose every group is hidden. */
  hidden: ReadonlySet<string>;
  /** Routes with their own colour are drawn in it; otherwise every route is coloured by frequency. */
  showBrandColors: boolean;
  /** Station and bus stop markers and labels are drawn. */
  showStops: boolean;
  /** Only vehicles with real positions are drawn (estimates hidden). */
  liveOnly: boolean;
  /** A shown plan draws bus corridors (packages/transit-map/README.md#bus-corridors). */
  corridors: boolean;
  /**
   * The map draws the shown plans' lines: their tiles in view have loaded. Until then a host can keep
   * drawing something in their place (the site's overview tiles).
   */
  linesReady: boolean;
  /** What corridor colours count: the hour from the shown time, or the weekday figure. */
  busFrequency: FrequencyWindow;
  /** "Now"'s hour as the corridors count it (epoch ms, `nowWindowStart`): [from, to). */
  busFrequencyHour: [number, number];
  /** The camera keeps the selected vehicle in view. */
  following: boolean;
  selected: SelectedVehicle | undefined;
  /** The selected station, stop, route line or combined route (exclusive with a selected vehicle). */
  place: PlaceSnapshot | RouteSnapshot | SharedSnapshot | undefined;
  /** The title of the card `back()` returns to, when this one was opened from another card. */
  back: string | undefined;
  /** A tap near several things: what it might have meant, to choose from (`choose`). */
  pick: PickMenu | undefined;
  /** Registry ids (@transitopia/shared/datasets.ts) of the data drawn right now. */
  datasets: string[];
  scenario: { name: string; description: string } | undefined;
  /**
   * A `?select=` key no feed shown has (another region's feature, or one only the resolver knows):
   * the host can look it up (GET /features/<key>) and move the map there.
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
/**
 * Bus frequencies (corridor, stop tick and vehicle colours, and "Now"'s label) follow the clock at
 * most this often: dragging the slider crosses a five-minute step nearly every frame, and working
 * them out again took a quarter of the main thread while it was shown for a frame (2026-10-31).
 */
const FREQUENCY_INTERVAL_MS = 250;
/**
 * While playing, vehicles are recomputed (and the map repainted) for a new time only once the
 * fastest could have moved this far on screen (px): zoomed out, a train moves about a pixel a
 * second, and recomputing every vehicle every frame kept the main thread busy for nothing.
 */
const MAX_STEP_PX = 0.5;
/** A tapped place is brought into view after this long, once its card is up and measured. */
const REVEAL_DELAY_MS = 150;
/** Tap tolerance around stations and stops (px). */
const PLACE_PICK_PX = 8;
/** A tap's menu lists at most this many things (packages/transit-map/README.md#tap-menu). */
const MAX_PICK_CHOICES = 8;
/** Station and exchange names: a tap menu offers the place wherever its name is tapped. */
const NAME_LAYERS = new Set(["stations-label", "exchanges-label"]);
/** Route lines a tap can pick a route from (bus, ferry and rail lines, and SkyTrain track). */
const ROUTE_LAYERS = [
  "routes-bus",
  "routes-bus-limited",
  "corridors-brand",
  "corridors-overview-brand",
  // Regular routes, drawn as the corridors they share (packages/transit-map/README.md#bus-corridors).
  "corridors",
  "corridors-overview",
  "corridors-idle",
  "corridors-overview-idle",
  "routes-shape",
  "routes-shape-inactive",
  "routes-skytrain",
  ...PICKABLE_TRACK_LAYERS,
];
/**
 * The focus another feed's layers get while a feed's route is focused (bus-frequency.ts): no route
 * has this key, so all of theirs are dimmed.
 */
const ELSEWHERE: Focus = { route: SEGMENT_FOCUS };
const SLIDER_START_S = SERVICE_DAY_ROLLOVER_H * 3600;
const SLIDER_END_S = (24 + SERVICE_DAY_ROLLOVER_H) * 3600;

export class TransitEngine {
  readonly clock: Clock;
  /** One per feed shown (packages/transit-map/README.md#feeds). */
  private readonly slots: readonly FeedSlot[];
  private readonly map: MlMap;
  /** Live dispatch, one poll per rail network a feed shown runs on (GET /networks/<id>/live/dispatch). */
  private readonly dispatchPolls: readonly LivePoller[];
  private readonly vehicles: VehicleLayer;
  private readonly debug: boolean;
  /** The time zone the clock's times and dates are shown in: the first feed's. */
  private readonly tz: string;
  private theme: Theme;
  private hiddenGroups: Set<RouteGroup>;
  /** Every feed's routes whose every group is hidden (`routeId`s, from each slot's `hidden`). */
  private hidden: ReadonlySet<string> = new Set();
  /** Every feed's route groups, by `routeId`, and the slots' maps they were merged from. */
  private groups:
    | {
        from: readonly ReadonlyMap<string, readonly RouteGroup[]>[];
        merged: ReadonlyMap<string, readonly RouteGroup[]>;
      }
    | undefined;
  private showBrandColors: boolean;
  private showStops: boolean;
  private liveOnly: boolean;
  private busFrequency: FrequencyWindow;
  /** The selected vehicle: its feed and id. */
  private selected: { feed: string; id: string } | undefined;
  /** The selected vehicle's route (`routeId`), once seen: computed even while its route is hidden. */
  private selectedRoute: string | undefined;
  private place: Place | undefined;
  private pick: PickMenu | undefined;
  /** When something was selected: bring it into view once its card is up (performance.now()). */
  private revealAt: number | undefined;
  /** The time bus frequencies are shown for (FREQUENCY_INTERVAL_MS), and when it was set (performance.now()). */
  private frequencyAt: { t: number; at: number } | undefined;
  private following = false;
  /** When the ease that starts (or re-aims) follow ends (performance.now()). */
  private followEaseEnds = 0;
  /** When the camera last moved (performance.now()). */
  private lastCameraMove = 0;
  /** Follow ended: drop the map padding it set, once the map stops moving (a drag may be under way). */
  private clearPaddingPending = false;
  /** Screen edges covered by the host's chrome (cards, time bar), px: follow keeps clear of them. */
  private viewPadding = { top: 0, right: 0, bottom: 0, left: 0 };
  /** Whether the engine is shown (`setVisible`). */
  private visible = true;
  /** Layers hidden by `setVisible(false)`, to show again. */
  private hiddenLayers: string[] = [];
  /** A `?select=` key waiting for the plans and their places files. */
  private pendingSelect: string | undefined;
  /** A `?select=` key no feed shown has (TransitSnapshot.elsewhere). */
  private elsewhere: string | undefined;
  /** False from a style swap until 'style.load': our layers are gone until then. */
  private styleReady = true;
  /** Every feed's vehicles at the time last computed. */
  private lastVehicles: VehicleState[] = [];
  /** Cards `open()` came through, for the back strip. */
  private readonly trail = new CardTrail<CardTarget>();
  private snapshot: TransitSnapshot;
  private listeners = new Set<() => void>();
  private lastPublish = 0;
  /** Something the snapshot shows changed: publish it this frame. */
  private dirty = true;
  /** Something vehicles depend on changed since they were last computed (see frame()). */
  private inputsChanged = true;
  /** The clock time, zoom and performance.now() vehicles were last computed at. */
  private computedFor = { t: NaN, zoom: NaN, at: -Infinity };
  /** The fastest any vehicle is set to move (m/s, from the kinematics config), for MAX_STEP_PX. */
  private maxSpeedMps: number;
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
    if (!opts.feeds.length) throw new Error("The engine shows no feeds");
    const slots = await Promise.all(
      opts.feeds.map((config) =>
        FeedSlot.create(
          config,
          { dataBase: opts.dataBase, apiBase: opts.apiBase },
          opts.scenario,
        ),
      ),
    );
    return new TransitEngine(map, slots, opts);
  }

  private constructor(
    map: MlMap,
    slots: readonly FeedSlot[],
    opts: TransitEngineOptions,
  ) {
    this.map = map;
    this.slots = slots;
    this.tz = this.primary.tz;
    this.theme = opts.theme;
    this.debug = opts.debug ?? false;
    const range = this.range();
    if (!range)
      throw new Error(
        'The timetable manifest lists no feeds. Run "npm run data".',
      );

    const url = opts.initial ?? readUrl(this.tz);
    if (url.preview)
      for (const slot of slots) slot.store.setPreview(url.preview);
    this.clock = new Clock(url.t ?? Date.now());
    this.clock.setBounds(range[0], range[1]);
    if (url.t === undefined && (Date.now() < range[0] || Date.now() > range[1]))
      this.clock.seek(range[0] + 8 * 3600_000);
    if (url.rate !== undefined) this.clock.setRate(url.rate);
    if (url.paused) this.clock.pause();
    // A vehicle is selected at once; a place once its plan (and places file) is in.
    this.selected = url.select ? this.vehicleOf(url.select) : undefined;
    if (this.selected === undefined) this.pendingSelect = url.select;
    this.hiddenGroups = new Set(
      loadPref<string[]>("hiddenGroups", []).filter((g): g is RouteGroup =>
        ROUTE_GROUPS.includes(g as RouteGroup),
      ),
    );
    this.showBrandColors = loadPref("showBrandColors", true);
    this.showStops = loadPref("showStops", true);
    this.liveOnly = loadPref("liveOnly", false);
    // "night" was a window once; it reads as "now".
    this.busFrequency =
      loadPref<string>("busFrequency", "now") === "day" ? "day" : "now";

    // Vehicles are sized for the first feed's kinematics, and recomputed for the fastest of any.
    this.vehicles = new VehicleLayer(
      map,
      this.primary.config.kinematics.sizing,
    );
    this.maxSpeedMps =
      Math.max(
        ...slots.flatMap(({ config: { kinematics } }) => [
          ...Object.values(kinematics.modes).map((k) => k.maxSpeed),
          ...Object.values(kinematics.routes).map((k) => k.maxSpeed ?? 0),
        ]),
      ) / 3.6;
    this.vehicles.selected = this.selected;
    // Each slot polls its feed's live endpoint; live dispatch is polled once per rail network, for
    // every feed on it.
    const byNetwork = new Map<string, FeedSlot[]>();
    for (const slot of slots) {
      const network = slot.config.rail?.network;
      if (network)
        byNetwork.set(network, [...(byNetwork.get(network) ?? []), slot]);
    }
    this.dispatchPolls = [...byNetwork].map(
      ([network, on]) =>
        new LivePoller(
          opts.apiBase
            && `${opts.apiBase}networks/${encodeURIComponent(network)}/live/dispatch`,
          on[0]!.config.rt,
          {
            onResponse: (r) => {
              const versions = sectionOf(r, "dispatch", "dispatch")?.versions;
              for (const slot of on) slot.store.setLiveDispatch(versions);
            },
            // Without live dispatch, the published patches still apply.
            onError: () => {},
            onStop: () => {},
          },
        ),
    );
    this.snapshot = this.buildSnapshot(this.clock.now());

    for (const slot of slots)
      slot.loadTracks(() => {
        if (!this.disposed) this.syncStatic(true);
      });
    this.syncStatic(true);

    const onStyleLoad = () => {
      this.styleReady = true;
      for (const slot of slots) slot.ferryPair = undefined;
      this.syncStatic(true);
    };
    // A new style (theme switch) replaces our sources and layers: wait for it to load. Only a new
    // style starting to load says so: 'styledata' also follows every layer change (the overview's,
    // a previous engine's removal), and while any tiles load the style doesn't count as loaded, so
    // a new engine still waiting for its plan would wait for a style.load that never comes.
    const onStyleLoading = () => {
      this.styleReady = false;
    };
    const onClick = (e: {
      point: { x: number; y: number };
      originalEvent: MouseEvent;
    }) => {
      if (!this.visible) return;
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
        this.select(vehicleId(v), {
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
      if (!this.visible) return;
      map.getCanvas().style.cursor =
        (
          this.vehicles.pickAt(e.point.x, e.point.y)
          || this.placeAt(e.point.x, e.point.y)
        ) ?
          "pointer"
        : "";
    };
    // A source loading tiles fires sourcedata; one showing tiles it already had may not: idle
    // catches those.
    const onSourceData = (e: { sourceId?: string }) => {
      if (!this.visible) return;
      let changed = false;
      for (const slot of slots) {
        const source = slot.ids.lines;
        if (
          slot.linesReady
          || (e.sourceId !== undefined && e.sourceId !== source)
          || !map.getSource(source)
          || !map.isSourceLoaded(source)
        )
          continue;
        slot.linesReady = changed = true;
      }
      if (changed) this.publish();
    };
    map.on("sourcedata", onSourceData);
    const onIdle = () => onSourceData({});
    map.on("idle", onIdle);
    map.on("style.load", onStyleLoad);
    map.on("styledataloading", onStyleLoading);
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
      map.off("sourcedata", onSourceData);
      map.off("idle", onIdle);
      map.off("style.load", onStyleLoad);
      map.off("styledataloading", onStyleLoading);
      map.off("click", onClick);
      map.off("mousemove", onMouseMove);
      map.getCanvas().style.cursor = "";
    });

    const invalidate = () => this.invalidate();
    let rebuilt = false;
    this.cleanups.push(
      this.clock.subscribe(() => {
        this.invalidate();
        this.writeUrlSoon();
      }),
      ...slots.flatMap((slot) => [
        slot.store.onChange(() => {
          if (slot.store.rebuilt) {
            if (!rebuilt) {
              rebuilt = true;
              this.writeUrl();
              opts.onRebuilt?.();
            }
            return;
          }
          this.syncHubs(slot);
          this.syncStatic();
          slot.clearDescribers();
          this.resolveSelection();
          this.invalidate();
        }),
        slot.rt.onChange(invalidate),
        slot.ais.onChange(invalidate),
      ]),
    );

    this.raf = requestAnimationFrame(this.frame);
    this.resolveSelection();
    // Drop a `?select=` that isn't a feature key (an old link's form), now rather than at the first
    // change.
    this.writeUrl();
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

  /** Seek to t: scrubbing, so the day's recorded buses start loading. */
  seek(t: number): void {
    this.clock.seek(t);
    for (const slot of this.slots) slot.rt.prefetchDay();
  }

  /** Jump to another service date at the same time of day. */
  seekDate(date: ServiceDate): void {
    const t = this.clock.now();
    const sec = (t - this.dayStart(this.displayDate(t))) / 1000;
    this.clock.seek(this.dayStart(date) + sec * 1000);
  }

  /** Seconds since the start of the displayed service day (the slider's value). */
  seekServiceSeconds(sec: number): void {
    const d = this.displayDate(this.clock.now());
    this.seek(this.dayStart(d) + sec * 1000);
  }

  /** Show or hide a group's routes (a route in another group that's shown stays drawn). */
  setGroupShown(group: RouteGroup, shown: boolean): void {
    this.hiddenGroups = new Set(this.hiddenGroups); // a new identity for the snapshot
    if (shown) this.hiddenGroups.delete(group);
    else this.hiddenGroups.add(group);
    savePref("hiddenGroups", [...this.hiddenGroups]);
    this.syncHidden();
    this.publish();
  }

  /**
   * Draw routes with their own colour (rail, ferries, the 99 B-Line, RapidBus) in it, or colour
   * every route by frequency, as the bus corridors are.
   */
  setBrandColors(on: boolean): void {
    this.showBrandColors = on;
    savePref("showBrandColors", on);
    if (this.styleReady) applyBrandColors(this.map, on);
    for (const slot of this.slots) slot.invalidateRouteColors();
    this.invalidate();
    this.publish();
  }

  /** Work out the hidden routes again (the groups or a shown plan changed), and filter the map's lines. */
  private syncHidden(): void {
    for (const slot of this.slots)
      slot.syncHidden(
        this.hiddenGroups,
        this.styleReady ? this.map : undefined,
      );
    this.mergeHidden();
  }

  /** Every feed's hidden routes as `routeId`s, a new set only when they changed. */
  private mergeHidden(): void {
    const hidden = new Set(
      this.slots.flatMap((s) => [...s.hidden].map((k) => feedKey(s.feed, k))),
    );
    if (
      hidden.size !== this.hidden.size
      || [...hidden].some((k) => !this.hidden.has(k))
    )
      this.hidden = hidden;
  }

  /** Every feed's route groups by `routeId`, the same map while no feed's changed. */
  private groupsOf(): ReadonlyMap<string, readonly RouteGroup[]> {
    const from = this.slots.flatMap((s) =>
      s.shown ? [s.groupsOf(s.shown)] : [],
    );
    const was = this.groups;
    if (
      was
      && was.from.length === from.length
      && was.from.every((g, i) => g === from[i])
    )
      return was.merged;
    const merged = new Map<string, readonly RouteGroup[]>();
    for (const slot of this.slots)
      if (slot.shown)
        for (const [key, groups] of slot.groupsOf(slot.shown))
          merged.set(feedKey(slot.feed, key), groups);
    this.groups = { from, merged };
    return merged;
  }

  setStopsShown(shown: boolean): void {
    this.showStops = shown;
    savePref("showStops", shown);
    if (this.styleReady)
      for (const slot of this.slots)
        applyStopsVisibility(this.map, slot.ids, shown);
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
   * Select a vehicle (by `vehicleId`, or none). A new selection follows it only when asked (easing
   * over from the one followed before); closing, or choosing another vehicle without asking, stops
   * following. Forgets the cards `open()` came through.
   */
  select(id: string | undefined, opts?: { follow?: boolean }): void {
    this.trail.clear();
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
    this.trail.clear();
    this.showPlace(place);
  }

  /**
   * Open another card from the one showing (a station's departure → its route, bay or vehicle), so
   * its back strip returns here; `from` is this card's title for that strip. A vehicle opened this
   * way is followed under the same rule as tapping it (apps/web/README.md#cross-references).
   */
  open(target: CardTarget, from: string): void {
    const here: CardTarget | undefined =
      this.selected ? { vehicle: this.selectedId! }
      : this.place ? { place: this.place }
      : undefined;
    if (here) this.trail.push(here, from);
    this.show(target);
    // A combined route can start well before the stop it was opened from.
    if ("place" in target && target.place.kind === "shared")
      this.locateSelected();
  }

  /** Back to the card the showing one was opened from. */
  back(): void {
    const prev = this.trail.pop();
    if (prev) this.show(prev);
  }

  private show(target: CardTarget): void {
    if ("place" in target) this.showPlace(target.place);
    else
      this.selectVehicle(target.vehicle, {
        follow: Math.abs(this.clock.rate) <= FOLLOW_MAX_RATE,
      });
  }

  /** The selected vehicle's `vehicleId`. */
  private get selectedId(): string | undefined {
    return this.selected && feedKey(this.selected.feed, this.selected.id);
  }

  /** Whether a vehicle is the selected one. */
  private isSelected(v: VehicleState): boolean {
    const s = this.selected;
    return s !== undefined && v.id === s.id && v.feed === s.feed;
  }

  /** The selected vehicle, if it was computed at the time last shown. */
  private selectedVehicle(): VehicleState | undefined {
    return this.selected && this.lastVehicles.find((v) => this.isSelected(v));
  }

  private selectVehicle(
    id: string | undefined,
    opts?: { follow?: boolean },
  ): void {
    const changed = id !== this.selectedId;
    const ref = id === undefined ? undefined : splitFeedKey(id);
    const selected = ref && { feed: ref.feed, id: ref.key };
    if (changed) {
      const v =
        selected
        && this.lastVehicles.find(
          (x) => x.id === selected.id && x.feed === selected.feed,
        );
      this.selectedRoute =
        v ? routeId({ feed: v.feed, key: v.routeKey }) : undefined;
    }
    const follow =
      changed ?
        selected !== undefined && (opts?.follow ?? false)
      : this.following;
    if (selected !== undefined && changed && !follow)
      this.revealAt = performance.now() + REVEAL_DELAY_MS;
    this.selected = this.vehicles.selected = selected;
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
    this.selected = this.vehicles.selected = undefined;
    this.selectedRoute = undefined;
    this.setFollow(false);
    this.place = place;
    this.pick = undefined;
    this.revealAt = performance.now() + REVEAL_DELAY_MS;
    this.syncPlaceHighlight();
    this.writeUrl();
    this.publish();
  }

  /** The first feed's slot: its time zone is the clock's, and its summaries the snapshot's. */
  private get primary(): FeedSlot {
    return this.slots[0]!;
  }

  private slotOf(feed: string): FeedSlot | undefined {
    return this.slots.find((s) => s.feed === feed);
  }

  /** The service date shown for an instant, in the clock's time zone. */
  private displayDate(t: number): ServiceDate {
    return displayServiceDate(t, this.tz);
  }

  /** Epoch ms of a service date's reference point, in the clock's time zone. */
  private dayStart(date: ServiceDate): number {
    return this.primary.dayStart(date);
  }

  /** Instants any feed has timetables for, from the first feed's first day to the last one's end. */
  private range(): [number, number] | undefined {
    const ranges = this.slots.flatMap((s) => {
      const r = s.store.range();
      return r ? [r] : [];
    });
    if (!ranges.length) return undefined;
    return [
      Math.min(...ranges.map((r) => r[0])),
      Math.max(...ranges.map((r) => r[1])),
    ];
  }

  /**
   * The rendered features of the given layers (by name, every feed's) within `d` px of a screen
   * point, each with its feed's slot and its layer's name.
   */
  private featuresAt(
    x: number,
    y: number,
    d: number,
    names: readonly string[],
  ): {
    f: ReturnType<MlMap["queryRenderedFeatures"]>[number];
    slot: FeedSlot;
    name: string;
  }[] {
    const { map } = this;
    const layers = this.slots.flatMap((s) =>
      names.map((n) => s.ids.layer(n)).filter((id) => map.getLayer(id)),
    );
    if (!layers.length) return [];
    return map
      .queryRenderedFeatures(
        [
          [x - d, y - d],
          [x + d, y + d],
        ],
        { layers },
      )
      .flatMap((f) => {
        for (const slot of this.slots) {
          const name = slot.ids.nameOf(f.layer.id);
          if (name !== undefined) return [{ f, slot, name }];
        }
        return [];
      });
  }

  /** The station, exchange or stop drawn under a screen point, if any (stations win, then exchanges). */
  private placeAt(x: number, y: number): Place | undefined {
    const hits = this.featuresAt(x, y, PLACE_PICK_PX, PLACE_LAYERS);
    const station = hits.find((h) => h.name.startsWith("stations"));
    if (station)
      return {
        kind: "station",
        feed: station.slot.feed,
        id: String(station.f.properties["id"]),
      };
    const exchange = hits.find((h) => h.name.startsWith("exchanges"));
    if (exchange)
      return {
        kind: "exchange",
        feed: exchange.slot.feed,
        id: String(exchange.f.properties["id"]),
      };
    const stop = hits.find((h) => h.f.properties["stop"] !== undefined);
    if (stop)
      return {
        kind: "stop",
        feed: stop.slot.feed,
        id: String(stop.f.properties["stop"]),
      };
    return this.routesAt(x, y, PLACE_PICK_PX)[0];
  }

  /**
   * Everything a tap at a screen point might have meant, within the selected place's ring: stations,
   * exchanges, vehicles, stops and route lines, in that order. A stop is left out when its exchange or
   * station is in. A route line that a vehicle, station or stop in the list is on doesn't count
   * towards asking, so a tap on a bus or a stop along its route doesn't ask; once the menu is asked
   * for anyway, it's listed too.
   */
  private choicesAt(x: number, y: number): PickChoice[] {
    const { map } = this;
    if (!this.styleReady || !this.slots.some((s) => s.shown)) return [];
    const r = SELECTED_PLACE_RADIUS_PX;
    const near = (f: { geometry: GeoJSON.Geometry }) => {
      if (f.geometry.type !== "Point") return false;
      const [lon, lat] = f.geometry.coordinates;
      const p = map.project([lon!, lat!]);
      return Math.hypot(p.x - x, p.y - y) <= r;
    };
    /** Routes (`routeId`s) a vehicle, station or stop in the list is on. */
    const covered = new Set<string>();
    const vehicles: PickChoice[] = [];
    for (const v of this.vehicles.pickWithin(x, y, r)) {
      covered.add(feedKey(v.feed, v.routeKey));
      vehicles.push({
        kind: "vehicle",
        id: vehicleId(v),
        vehicle: v,
        route: this.slotOf(v.feed)?.shown?.routes.get(v.routeKey),
      });
    }
    const hits = this.featuresAt(x, y, r, PLACE_LAYERS).filter(
      (h) => NAME_LAYERS.has(h.name) || near(h.f),
    );
    const found = new Map<string, Place>();
    const keyOf = (p: Place) => `${p.kind}:${p.feed}:${p.id}`;
    for (const kind of ["station", "exchange", "stop"] as const)
      for (const { f, slot, name } of hits) {
        const id =
          kind === "station" ?
            name.startsWith("stations") ?
              f.properties["id"]
            : undefined
          : kind === "exchange" ?
            name.startsWith("exchanges") ?
              f.properties["id"]
            : undefined
          : f.properties["stop"];
        if (id === undefined) continue;
        const place: Place = { kind, feed: slot.feed, id: String(id) };
        found.set(keyOf(place), place);
        for (const k of String(f.properties["routes"] ?? "").split(","))
          if (k) covered.add(feedKey(slot.feed, k));
      }
    // A station's or exchange's bays are on its card.
    for (const slot of this.slots) {
      if (!slot.shown) continue;
      const feed = slot.feed;
      for (const h of hubsOf(slot.shown.plan))
        if (
          found.has(keyOf({ kind: "exchange", feed, id: h.id }))
          || (h.station !== undefined
            && found.has(keyOf({ kind: "station", feed, id: h.station })))
        )
          for (const b of h.bays)
            found.delete(keyOf({ kind: "stop", feed, id: b }));
    }
    const routes = this.routesAt(x, y, r);
    const uncovered = routes.filter((p) => !covered.has(feedKey(p.feed, p.id)));
    const asks = vehicles.length + found.size + uncovered.length > 1;
    for (const place of asks ? routes : uncovered)
      found.set(keyOf(place), place);
    // Stations, exchanges, vehicles, stops, then routes, so the list's cut drops the least likely.
    const out: PickChoice[] = [];
    const add = (kinds: readonly Place["kind"][]) => {
      for (const place of found.values()) {
        if (!kinds.includes(place.kind)) continue;
        const pp = this.slotOf(place.feed)?.shown;
        const c = pp && placeChoice(pp, place);
        if (c) out.push(c);
      }
    };
    add(["station", "exchange"]);
    out.push(...vehicles);
    add(["stop", "route"]);
    return out.slice(0, MAX_PICK_CHOICES);
  }

  /** The route lines within `d` px of a screen point, topmost first, as places. */
  private routesAt(x: number, y: number, d: number): Place[] {
    const out = new Map<string, Place>();
    const add = (slot: FeedSlot, key: string) => {
      if (slot.shown?.routes.has(key) && !slot.hidden.has(key))
        out.set(feedKey(slot.feed, key), {
          kind: "route",
          feed: slot.feed,
          id: key,
        });
    };
    for (const { f, slot, name } of this.featuresAt(x, y, d, ROUTE_LAYERS)) {
      if (/^corridors(-overview)?(-idle)?$/.test(name)) {
        for (const key of slot.frequencyLayer?.routesOn(
          f.sourceLayer ?? PLAN_TILE_LAYERS.corridors,
          Number(f.id),
        ) ?? [])
          add(slot, key);
        continue;
      }
      // Corridors carry the route with its own colour drawn on them as feature state.
      const brand = name.endsWith("-brand") ? f.state["brand"] : undefined;
      if (name.endsWith("-brand") && !(typeof brand === "number" && brand >= 0))
        continue;
      const brands = slot.shown ? brandedRoutes(slot.shown.plan) : [];
      add(
        slot,
        typeof brand === "number" ?
          (brands[brand]?.key ?? "")
        : String(f.properties["route"] ?? f.properties["line"] ?? ""),
      );
    }
    return [...out.values()];
  }

  /** The selected place's feed's slot and shown plan. */
  private placeSlot(): FeedSlot | undefined {
    return this.place && this.slotOf(this.place.feed);
  }

  /** Where the selected place is, for its highlight and "Centre on map". */
  private placePoint(): [number, number] | undefined {
    const pp = this.placeSlot()?.shown;
    return pp && this.place ? placeLocation(pp, this.place) : undefined;
  }

  /** The route whose card is open (`routeId`), when the map draws it: the map dims every other route. */
  private focusRoute(): string | undefined {
    const place = this.place;
    if (place?.kind !== "route") return undefined;
    return this.placeSlot()?.shown?.routes.has(place.id) ?
        feedKey(place.feed, place.id)
      : undefined;
  }

  /**
   * What a feed's corridors focus on (packages/transit-map/README.md#route-focus): the route whose
   * card is open, or the combined route's stretch, when they're the feed's; ELSEWHERE when they're
   * another feed's.
   */
  private focusOf(slot: FeedSlot): Focus | undefined {
    const route = this.focusRoute();
    const place = this.place;
    if (route !== undefined)
      return place!.feed === slot.feed ? { route: place!.id } : ELSEWHERE;
    const info = this.segmentInfo();
    if (!info?.segment || !place) return undefined;
    return place.feed === slot.feed ?
        {
          key: place.id,
          routes: new Set(info.segment.routes),
          sources: info.sources,
          corridors: info.corridors,
          stops: info.stops,
        }
      : ELSEWHERE;
  }

  /** Keep the open combined route's SkyTrain pieces marked (FeedSlot.syncRailFocus), and no other feed's. */
  private syncRailFocus(): void {
    const info = this.segmentInfo();
    for (const slot of this.slots)
      slot.syncRailFocus(
        this.map,
        this.place?.feed === slot.feed ? info?.rail : undefined,
      );
  }

  private syncPlaceHighlight(): void {
    const route = this.focusRoute();
    const info = route === undefined ? this.segmentInfo() : undefined;
    const place = this.place;
    this.vehicles.focus =
      route !== undefined ?
        (v) => v.feed === place!.feed && v.routeKey === place!.id
      : info?.segment ? info.onSegment
      : undefined;
    if (!this.styleReady || this.disposed) return;
    setSelectedPlace(
      this.map,
      this.placePoint(),
      firstFeedLayer(this.map, "stations"),
    );
    setFocus(
      this.map,
      route !== undefined ? { route }
      : info?.segment ?
        { stops: info.stopIds.map((id) => feedKey(place!.feed, id)) }
      : undefined,
    );
  }

  /** The open combined route in its feed (FeedSlot.segmentInfo). */
  private segmentInfo(): SegmentInfo | undefined {
    return this.place && this.placeSlot()?.segmentInfo(this.place);
  }

  /** Centre the map on the selected vehicle (or station or stop), in the part of the map the host's chrome leaves clear. */
  locateSelected(): void {
    if (this.place?.kind === "route") {
      this.fitRoute(this.place);
      return;
    }
    if (this.place?.kind === "shared") {
      const pp = this.placeSlot()?.shown;
      const segment = this.segmentInfo()?.segment;
      if (pp && segment)
        this.fitLines(
          segmentLines(pp.plan, segment, (s) => pp.shapeCum.get(s)),
        );
      return;
    }
    const v =
      this.selectedVehicle()
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
  private fitRoute(route: Place): void {
    const plan = this.slotOf(route.feed)?.shown?.plan;
    if (!plan) return;
    this.fitLines(
      plan.patterns
        .filter((p) => p.route === route.id)
        .map((p) => (plan.shapes[p.shape] ?? []) as LonLat[]),
    );
  }

  /** Fit lines into the area the host's chrome leaves clear. */
  private fitLines(lines: readonly LonLat[][]): void {
    let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const line of lines)
      for (const [lon, lat] of line) {
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
   * A route's hourly frequency for each kind of day in its feed's shown plan, the shown date's kind
   * first (cached: it doesn't change with the time).
   */
  routeDays(route: Pick<PlanRoute, "feed" | "key">): RouteDay[] {
    return (
      this.slotOf(route.feed)?.routeDays(route.key, this.clock.now()) ?? []
    );
  }

  /**
   * The open combined route's hourly frequency (its buses leaving its start) for each kind of day in
   * its feed's shown plan, the shown date's kind first, as `routeDays`.
   */
  sharedDays(): RouteDay[] {
    const info = this.segmentInfo();
    return (info && this.placeSlot()?.sharedDays(info, this.clock.now())) ?? [];
  }

  /**
   * A route's weekday figure (minutes, `PlanRoute.weekdayWait`: the median of each daytime hour's
   * worst wait on regular weekdays, as the map's "Day" bus frequency), worked out here for a plan
   * published without it; undefined when it doesn't run then.
   */
  dayWait(route: Pick<PlanRoute, "feed" | "key">): number | undefined {
    const slot = this.slotOf(route.feed);
    return slot?.shown && slot.dayWait(slot.shown, route.key);
  }

  /** Keep the selected vehicle at the centre of the view (or stop). */
  setFollowing(on: boolean): void {
    this.setFollow(on && this.selected !== undefined);
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
    const v = this.selectedVehicle();
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
    const v = this.selectedVehicle();
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
    const v = this.selectedVehicle();
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

  /**
   * Hide the engine (its layers, vehicles, taps) and pause it (no frames, no live polling), or show
   * it again as it was: a host keeps the engine of a region it zoomed out of, to show it again at
   * once when zoomed back in (apps/web/README.md#transit-mode). The clock keeps its time.
   */
  setVisible(visible: boolean): void {
    if (visible === this.visible || this.disposed) return;
    this.visible = visible;
    const { map } = this;
    if (!visible) {
      cancelAnimationFrame(this.raf);
      this.stopLive();
      this.setFollow(false);
      // Vehicles are sized for the zoom they were computed at: none are kept to be drawn, for a
      // frame, at another when shown again.
      this.vehicles.update([], this.theme === "dark");
      this.vehicles.detach();
      this.hiddenLayers = [];
      const sources = this.sources();
      for (const layer of map.getStyle()?.layers ?? [])
        if (
          "source" in layer
          && sources.includes(layer.source)
          && map.getLayoutProperty(layer.id, "visibility") !== "none"
        ) {
          this.hiddenLayers.push(layer.id);
          map.setLayoutProperty(layer.id, "visibility", "none");
        }
      return;
    }
    for (const id of this.hiddenLayers)
      if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "visible");
    this.hiddenLayers = [];
    // Its tiles in the new view load from now on (MapLibre loads none for hidden layers).
    for (const slot of this.slots) slot.linesReady = false;
    // Layers a new style (a theme switch while hidden) dropped are added again.
    this.syncStatic(true);
    // Vehicles for this view before the layer draws again.
    const t = this.clock.now();
    this.computedFor = { t, zoom: this.map.getZoom(), at: performance.now() };
    this.computeVehicles(t);
    this.attachVehicles();
    this.invalidate();
    this.publish();
    this.raf = requestAnimationFrame(this.frame);
  }

  /** Stop every live poll: each feed's and each rail network's. */
  private stopLive(): void {
    for (const slot of this.slots) slot.live.stop();
    for (const poll of this.dispatchPolls) poll.stop();
  }

  /** Sources the engine adds to the host's map (removed on dispose). */
  private sources(): string[] {
    return [SELECTED_PLACE_SOURCE, ...this.slots.flatMap((s) => s.ids.sources)];
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.setFollow(false);
    this.clearMapPadding();
    clearTimeout(this.urlTimer);
    for (const fn of this.cleanups) fn();
    this.stopLive();
    this.vehicles.detach();
    removeSources(this.map, this.sources());
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
   * What selection keys are resolved against in a feed: its shown plan and its places file (null
   * while it loads when `waitForPlaces` is false, so the key is a ref until the file is in).
   */
  private selectContext(
    slot: FeedSlot,
    waitForPlaces: boolean,
  ): SelectContext | undefined {
    const pp =
      slot.shown
      ?? slot.store.planFor(slot.displayDate(this.clock.now()), Infinity);
    if (!pp) return undefined;
    const places = slot.store.placesFor(pp);
    if (places === undefined && waitForPlaces) return undefined;
    return {
      feed: slot.feed,
      plan: pp.plan,
      hubs: hubsOf(pp.plan),
      places: places ?? null,
    };
  }

  /**
   * The vehicle a `?select=` key names in a feed shown, if it names one: an `rt` key names its feed;
   * a `run` key (packages/transit-map/src/select.ts) is the first feed's.
   */
  private vehicleOf(key: string): { feed: string; id: string } | undefined {
    for (const slot of this.slots) {
      const id = vehicleOfKey(key, slot.feed);
      if (id !== undefined) return { feed: slot.feed, id };
    }
    return undefined;
  }

  /**
   * Select what the URL's key names, once every feed's plan and places file are in: the first feed
   * that has it (a feature ID is one feed's), else it's elsewhere.
   */
  private resolveSelection(): void {
    const key = this.pendingSelect;
    if (key === undefined) {
      // The places file may have arrived: write the canonical key.
      if (this.place) this.writeUrl();
      return;
    }
    const contexts = this.slots.map((s) => this.selectContext(s, true));
    if (contexts.some((c) => !c)) return;
    this.pendingSelect = undefined;
    let elsewhere = false;
    for (const ctx of contexts) {
      const r = resolveSelect(key, ctx!);
      if (r === "elsewhere") {
        elsewhere = true;
        continue;
      }
      if (!r) break;
      if ("vehicle" in r) this.selectVehicle(feedKey(ctx!.feed, r.vehicle));
      else this.showPlace(r.place);
      return;
    }
    if (elsewhere) {
      this.elsewhere = key;
      this.publish();
    } else this.writeUrl();
  }

  /** The selection's key for the URL: canonical once it's resolved, else as given. */
  private selectionKey(): string | undefined {
    if (this.selected) return vehicleKey(this.selected.feed, this.selected.id);
    const slot = this.placeSlot();
    if (this.place && slot) {
      const ctx = this.selectContext(slot, false);
      return ctx && selectKey({ place: this.place }, ctx);
    }
    return this.pendingSelect ?? this.elsewhere;
  }

  private writeUrl(): void {
    if (!this.disposed) writeUrl(this.clock, this.selectionKey(), this.tz);
  }

  /** Writes the URL once a burst of clock changes settles (URL_WRITE_THROTTLE_MS). */
  private writeUrlSoon(): void {
    if (this.urlTimer !== undefined) return;
    this.urlTimer = setTimeout(() => {
      this.urlTimer = undefined;
      this.writeUrl();
    }, URL_WRITE_THROTTLE_MS);
  }

  /** The time bus frequencies are shown for: the clock's, at most FREQUENCY_INTERVAL_MS behind. */
  private frequencyTime(): number {
    return this.frequencyAt?.t ?? this.clock.now();
  }

  private sliderRange(t: number): [number, number] {
    const start = this.dayStart(this.displayDate(t));
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
    const serviceDate = this.displayDate(t);
    const feeds = this.slots.flatMap((s) => s.store.manifest.feeds);
    const selected =
      this.selected === undefined ?
        undefined
      : (() => {
          const v = this.selectedVehicle();
          const route =
            v ? this.slotOf(v.feed)?.shown?.routes.get(v.routeKey) : undefined;
          return {
            id: this.selectedId!,
            vehicle: v,
            route,
            trip: v && this.tripSummary(v),
            datasets: this.datasetsOf([
              [route, v !== undefined && v.provenance !== "estimated"],
            ]),
          };
        })();
    const prev = this.snapshot as TransitSnapshot | undefined;
    const routes = this.slots.flatMap((s) => s.shown?.plan.routes ?? []);
    const scenario = this.primary.store.scenario;
    return {
      t,
      timezone: this.tz,
      serviceDate,
      serviceLabel: this.primary.describeDate(serviceDate),
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
      preview: [
        ...new Set(this.slots.flatMap((s) => s.store.previewDates)),
      ].sort(),
      // Stable identities, so React skips re-rendering the legend.
      routes: prev && sameRoutes(prev.routes, routes) ? prev.routes : routes,
      groups: this.groupsOf(),
      hiddenGroups: this.hiddenGroups,
      hidden: this.hidden,
      showBrandColors: this.showBrandColors,
      showStops: this.showStops,
      liveOnly: this.liveOnly,
      corridors: this.slots.some((s) => Boolean(s.shown?.plan.corridorInfo)),
      linesReady: this.slots.every((s) => s.linesReady),
      busFrequency: this.busFrequency,
      busFrequencyHour: (() => {
        const ft = this.frequencyTime();
        const day = this.dayStart(this.displayDate(ft));
        const from = day + nowWindowStart((ft - day) / 1000) * 1000;
        const same = prev?.busFrequencyHour;
        // A stable identity while the window stays put, so React skips re-rendering the key.
        return same?.[0] === from ? same : [from, from + 3600_000];
      })(),
      following: this.following,
      selected,
      place: this.placeSnapshot(t),
      back: this.trail.backLabel,
      pick: this.pick,
      datasets:
        prev && prev.datasets.join() === this.datasets.join() ?
          prev.datasets
        : this.datasets,
      scenario:
        scenario ?
          { name: scenario.name, description: scenario.description }
        : undefined,
      elsewhere: this.elsewhere,
    };
  }

  /** The selected vehicle's trip: where and when riders can first board it (epoch ms), and its short id. */
  private tripSummary(v: VehicleState): SelectedVehicle["trip"] {
    const slot = this.slotOf(v.feed);
    // A vehicle's trip is loaded, or it wouldn't be drawn.
    const pp = slot?.store.planFor(v.serviceDate, Infinity);
    const pt = pp?.tripIndex.get(v.tripId);
    if (!slot || !pp || !pt) return undefined;
    const i = firstBoarding(pt.pattern);
    return {
      start: slot.dayStart(v.serviceDate) + pt.dep[i]! * 1000,
      from: placeName(pp.plan, pt.pattern.stops[i]!),
      shortId: shortId(pp.plan.tripIdPattern, v.tripId),
    };
  }

  /**
   * The selected place's card: departures from it after the shown time, from the timetable shifted
   * by the real-time corrections the vehicles use (packages/transit-core/DESIGN.md#departures).
   */
  private placeSnapshot(
    t: number,
  ): PlaceSnapshot | RouteSnapshot | SharedSnapshot | undefined {
    const slot = this.placeSlot();
    const pp = slot?.shown;
    if (!this.place || !slot || !pp) return undefined;
    return placeSnapshot(this.place, {
      pp,
      t,
      vehicles: this.lastVehicles,
      drawn: (v) =>
        !this.hiddenRoute(v)
        && !(this.liveOnly && v.provenance === "estimated"),
      corrections: (d) => slot.lastCorrections?.get(d),
      datasetsOf: (routes) => this.datasetsOf(routes),
      segment: () => this.segmentInfo(),
    });
  }

  /** Whether a vehicle's route is hidden. */
  private hiddenRoute(v: VehicleState): boolean {
    return this.slotOf(v.feed)?.hidden.has(v.routeKey) ?? false;
  }

  /**
   * When a feed's shown plan's places file arrives, its stations and exchanges replace the plan's
   * own grouping (src/hubs.ts): redraw them, and keep an open exchange card of that feed on the
   * exchange sharing its bays (its id is now the feature's).
   */
  private syncHubs(slot: FeedSlot): void {
    const pp = slot.shown;
    if (!pp) return;
    slot.store.placesFor(pp);
    const hubs = hubsOf(pp.plan);
    if (hubs === slot.shownHubs) return;
    const old = slot.shownHubs;
    slot.shownHubs = hubs;
    const place = this.place;
    if (
      place?.kind === "exchange"
      && place.feed === slot.feed
      && !hubs.some((h) => h.id === place.id)
    ) {
      const bays = new Set(old?.find((h) => h.id === place.id)?.bays);
      const now = hubs.find((h) => h.bays.some((b) => bays.has(b)));
      this.place =
        now ?
          now.station !== undefined ?
            { kind: "station", feed: slot.feed, id: now.station }
          : { kind: "exchange", feed: slot.feed, id: now.id }
        : undefined;
    }
    this.syncStatic(true);
  }

  /**
   * Static layers follow each feed's plan for the displayed date (FeedSlot.drawStatic); whenever a
   * feed's are redrawn, what's map-wide goes with them: the brand colour switch, the selected
   * place's ring and the focus, and the vehicles' place beneath the labels.
   */
  private syncStatic(force = false): void {
    const { map } = this;
    if (!this.visible || !this.styleReady || this.disposed) return;
    const t = this.clock.now();
    let drawn = false;
    for (const slot of this.slots) {
      const shown = slot.shown?.plan;
      const r = slot.drawStatic(map, t, {
        theme: this.theme,
        force,
        hiddenGroups: this.hiddenGroups,
        showStops: this.showStops,
        debug: this.debug,
        vehicles: this.vehicles,
        isDisposed: () => this.disposed,
      });
      if (slot.shown?.plan !== shown) this.mergeHidden();
      drawn ||= r === true;
    }
    if (!drawn) return;
    // A new style (a theme switch) has no global state: set it again.
    applyBrandColors(map, this.showBrandColors);
    this.syncPlaceHighlight();
    this.attachVehicles();
    // Published with the rest at the end (invalidate).
    this.invalidate();
  }

  /** Vehicles go beneath every feed's stop labels, above their focused routes (layers/order.ts). */
  private attachVehicles(): void {
    this.vehicles.attach(firstFeedLayer(this.map, VEHICLES_BEFORE_LAYER));
  }

  private frame = (): void => {
    if (this.disposed) return;
    const { clock, map } = this;
    const t = clock.now();
    const scenario = this.primary.store.scenario !== undefined;
    // Scenarios are hypothetical: never mix in real bus positions.
    if (!scenario) {
      for (const slot of this.slots) {
        slot.rt.update(t, this.sliderRange(t));
        slot.live.update(t);
      }
      for (const poll of this.dispatchPolls) poll.update(t);
    }
    // Vehicles (and the map repaint their upload triggers) only when something they depend on
    // changed: the time (once vehicles could have moved MAX_STEP_PX), the zoom (minimum drawn
    // sizes), or an input (data, selection, filters). Paused, that's almost never;
    // IDLE_RECOMPUTE_MS covers what ages with wall-clock time.
    const zoom = map.getZoom();
    const at = performance.now();
    const stepMs =
      (1000 * MAX_STEP_PX * metresPerPixel(map.getCenter().lat, zoom))
      / (this.maxSpeedMps * Math.abs(clock.rate || 1));
    if (
      this.inputsChanged
      || (t !== this.computedFor.t && at - this.computedFor.at >= stepMs)
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
      // The slider shades where the first feed's buses are real (its badge's).
      const next = this.primary.rt.coverageFor(lo, hi);
      if (JSON.stringify(next) !== JSON.stringify(this.coverage)) {
        this.coverage = next;
        this.dirty = true;
      }
    }
    this.syncStatic();
    if (
      !this.frequencyAt
      || (t !== this.frequencyAt.t
        && at - this.frequencyAt.at >= FREQUENCY_INTERVAL_MS)
    ) {
      this.frequencyAt = { t, at };
      this.dirty = true; // "Now"'s label
    }
    const ft = this.frequencyTime();
    if (this.styleReady)
      for (const slot of this.slots) {
        if (!slot.frequencyLayer) continue;
        const date = slot.displayDate(ft);
        slot.frequencyLayer.update(
          map,
          date,
          (ft - slot.dayStart(date)) / 1000,
          this.busFrequency,
          slot.hidden,
          this.focusOf(slot),
        );
      }
    if (this.styleReady) this.syncRailFocus();
    for (const slot of this.slots)
      if (
        slot.syncRouteColors(this.styleReady ? map : undefined, this.vehicles, {
          t: ft,
          theme: this.theme,
          showBrandColors: this.showBrandColors,
          window: this.busFrequency,
        })
      )
        this.inputsChanged = true;
    if (this.following && this.styleReady) this.keepCentred();
    else if (this.clearPaddingPending && !map.isMoving())
      this.clearMapPadding();
    if (this.revealAt !== undefined && performance.now() > this.revealAt) {
      this.revealAt = undefined;
      const at = this.placePoint();
      const v = this.selectedVehicle();
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

  /** Every feed's vehicles at t, the corrections and badges that go with them, drawn on the map. */
  private computeVehicles(t: number): void {
    const scenario = this.primary.store.scenario !== undefined;
    // Hidden routes aren't computed, except the selected vehicle's and the open route card's:
    // hiding a layer hides it from the map, but its cards stay true. Until the selected vehicle
    // has been seen, compute everything to find it.
    const keep = new Set<string>();
    if (this.selectedRoute) keep.add(this.selectedRoute);
    const place = this.place;
    if (place?.kind === "route") keep.add(feedKey(place.feed, place.id));
    for (const r of this.segmentInfo()?.routes ?? [])
      keep.add(feedKey(place!.feed, r));
    const byFeed: FeedVehicles[] = this.slots.map((slot) => {
      const visible =
        !slot.hidden.size || (this.selected && !this.selectedRoute) ?
          undefined
        : new Set(
            (slot.shown?.plan.routes ?? [])
              .map((r) => r.key)
              .filter(
                (k) => !slot.hidden.has(k) || keep.has(feedKey(slot.feed, k)),
              ),
          );
      const selected = this.selected;
      const own = selected?.feed === slot.feed ? selected.id : undefined;
      const out = slot.vehiclesAt(t, {
        visible,
        selected: (id) => id === own,
        place: place !== undefined,
        scenario,
      });
      slot.syncFerryPair(this.styleReady ? this.map : undefined, t, scenario);
      return out;
    });
    this.lastVehicles = byFeed.flatMap((f) => f.vehicles);
    if (this.selected) {
      const v = this.selectedVehicle();
      if (v) this.selectedRoute = feedKey(v.feed, v.routeKey);
    }

    const notices =
      scenario ? [] : this.slots.flatMap((s) => s.store.noticesAt(t));
    if (notices.join("\n") !== this.notices.join("\n")) {
      this.notices = notices;
      this.dirty = true;
    }
    // The badge says where the first feed's buses come from.
    const mode = byFeed[0]!.mode;
    const [label, title] = RT_BADGE[mode];
    const status = this.primary.rt.liveStatus();
    const fullTitle = status ? `${title} (${status})` : title;
    if (
      mode !== this.rtState.mode
      || label !== this.rtState.label
      || fullTitle !== this.rtState.title
    ) {
      this.rtState = { mode, label, title: fullTitle };
      this.dirty = true;
    }
    this.datasets = this.datasetsDrawn(
      byFeed.flatMap((f) => f.live),
      byFeed.some((f) => f.aisUsed),
    );

    if (this.styleReady)
      this.vehicles.update(
        // The selected vehicle stays, so its card (and follow) still point at something.
        this.lastVehicles.filter(
          (v) =>
            this.isSelected(v)
            || (!this.hiddenRoute(v)
              && !(this.liveOnly && v.provenance === "estimated")),
        ),
        this.theme === "dark",
      );
  }

  /**
   * The datasets behind routes: each route's schedule (the plan's, else its feed's), and its
   * provider's real-time data where `realtime` (real positions or predicted times are shown).
   */
  private datasetsOf(
    routes: Iterable<[PlanRoute | undefined, boolean]>,
  ): string[] {
    const out = new Set<string>();
    for (const [route, realtime] of routes) {
      const schedule =
        route?.dataset
        ?? (route && this.slotOf(route.feed)?.config.feed.dataset);
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
    const routeOf = (v: VehicleState) =>
      this.slotOf(v.feed)?.shown?.routes.get(v.routeKey);
    const out = this.datasetsOf([
      ...this.slots.flatMap((s) =>
        (s.shown?.plan.routes ?? [])
          .filter((r) => !s.hidden.has(r.key))
          .map((r): [PlanRoute, boolean] => [r, false]),
      ),
      ...this.lastVehicles.map((v): [PlanRoute | undefined, boolean] => [
        routeOf(v),
        false,
      ]),
      ...rtVehicles.map((v): [PlanRoute | undefined, boolean] => [
        routeOf(v),
        true,
      ]),
    ]);
    if (aisUsed) out.push("aisstream");
    // The track network is imported from OpenStreetMap plus our overrides; corrections are ours.
    if (this.slots.some((s) => s.tracks)) out.push("osm", "transitopia");
    return out;
  }

  /** Debug handle for the console (window.transit). */
  debugHandle(): object {
    const primary = this.primary;
    return {
      map: this.map,
      clock: this.clock,
      slots: this.slots,
      store: primary.store,
      rt: primary.rt,
      vehicles: () => this.lastVehicles,
    };
  }
}

function sameRoutes(a: PlanRoute[], b: PlanRoute[]): boolean {
  return (
    a.length === b.length
    && a.every(
      (r, i) =>
        r.feed === b[i]!.feed
        && r.key === b[i]!.key
        && r.color === b[i]!.color
        && r.label === b[i]!.label,
    )
  );
}
