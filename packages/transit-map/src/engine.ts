// The transit engine, mounted imperatively on a MapLibre map the host owns (V2-PLAN.md §4.2):
// clock → playback → WebGL each frame, without React. Hosts read a small snapshot store (throttled
// to a few updates a second, plus every discrete change) with useSyncExternalStore, and call the
// methods here for controls.

import type { Map as MlMap } from "maplibre-gl";
import type { Theme } from "@transitopia/map-style/basemap.ts";
import { TrackGraph } from "@transitopia/transit-core/infra/graph.ts";
import type { InfraCollection } from "@transitopia/transit-core/infra/types.ts";
import {
  addDays,
  localDate,
  serviceDayStart,
} from "@transitopia/transit-core/time.ts";
import {
  makeServiceDescriber,
  type ServiceDayInfo,
} from "@transitopia/transit-core/gtfs/describe.ts";
import {
  feedForDate,
  type PlanRoute,
} from "@transitopia/transit-core/plan/types.ts";
import type {
  PreparedPlan,
  VehicleState,
} from "@transitopia/transit-core/schedule/engine.ts";
import { Clock } from "./clock.ts";
import {
  PlanStore,
  SERVICE_DAY_ROLLOVER_H,
  displayServiceDate,
  kinematics,
  mergeCorrections,
} from "./plans.ts";
import {
  BUS_STOPS_SOURCE,
  BUS_TICKS_SOURCE,
  ROUTES_SOURCE,
  STATIONS_SOURCE,
  addStaticLayers,
  applyRouteFilter,
  setFerryPair,
} from "./layers/static.ts";
import { VehicleLayer } from "./layers/vehicles.ts";
import {
  DEBUG_SOURCE,
  TRACKS_SOURCE,
  addTrackLayers,
  applyTrackFilter,
  loadPlatforms,
  loadTracks,
  setDebugPlatforms,
} from "./layers/tracks.ts";
import { readUrl, writeUrl, type UrlState } from "./url.ts";
import { RtClient, type RtMode } from "./rt.ts";
import { AisClient } from "./ais.ts";
import { loadPref, savePref } from "./prefs.ts";

export type { Theme };
export type { RtMode };
export { RATES } from "./clock.ts";

export interface TransitEngineOptions {
  /** URL prefix of the published data (…/data/manifest.json), ending in "/". */
  dataBase: string;
  /** URL prefix of the RT service (…/rt/live), ending in "/"; omit for schedules only. */
  apiBase?: string | undefined;
  theme: Theme;
  /** Build a scenario's plans instead of the real network (?scenario=<name>). */
  scenario?: string | undefined;
  /** Segment ids and platform markers on the tracks (?debug=1). */
  debug?: boolean | undefined;
  /** Initial time, rate and selection; defaults to the current URL. */
  initial?: UrlState | undefined;
}

export interface SelectedVehicle {
  id: string;
  /** Undefined when the vehicle isn't in service at the shown time. */
  vehicle: VehicleState | undefined;
  route: PlanRoute | undefined;
}

export interface TransitSnapshot {
  /** Shown instant, epoch ms (updated a few times a second while playing). */
  t: number;
  /** Displayed service date (YYYYMMDD) and its description ("Weekday", "Sunday/holiday", …). */
  serviceDate: string;
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
  selected: SelectedVehicle | undefined;
  /** Registry ids (@transitopia/shared/datasets.ts) of the data drawn right now. */
  datasets: string[];
  scenario: { name: string; description: string } | undefined;
}

const RT_BADGE: Record<RtMode, [string, string]> = {
  live: ["Buses: live", "Bus positions from TransLink real-time data"],
  recorded: [
    "Buses: recorded",
    "Bus positions replayed from recorded real-time data",
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

/** Snapshot refresh while playing (discrete changes publish immediately). */
const SNAPSHOT_INTERVAL_MS = 200;
/** Sources the engine adds to the host's map (removed on dispose). */
const SOURCES = [
  ROUTES_SOURCE,
  STATIONS_SOURCE,
  BUS_STOPS_SOURCE,
  BUS_TICKS_SOURCE,
  TRACKS_SOURCE,
  DEBUG_SOURCE,
];
const SLIDER_START_S = SERVICE_DAY_ROLLOVER_H * 3600;
const SLIDER_END_S = (24 + SERVICE_DAY_ROLLOVER_H) * 3600;

export class TransitEngine {
  readonly clock: Clock;
  readonly store: PlanStore;
  private readonly map: MlMap;
  private readonly rt: RtClient;
  private readonly ais: AisClient;
  private readonly vehicles: VehicleLayer;
  private readonly debug: boolean;
  private theme: Theme;
  private hidden: Set<string>;
  private selectedId: string | undefined;
  private tracks: InfraCollection | undefined;
  private shownFeed: PreparedPlan | undefined;
  /** False from a style swap until 'style.load': our layers are gone until then. */
  private styleReady = true;
  /** The SeaBus berth pair last applied to the map (re-applied after the style reloads). */
  private ferryPair: string | null | undefined;
  private lastVehicles: VehicleState[] = [];
  private describers = new Map<string, (d: string) => ServiceDayInfo>();
  private snapshot: TransitSnapshot;
  private listeners = new Set<() => void>();
  private lastPublish = 0;
  private dirty = true;
  private lastCoverageUpdate = 0;
  private coverage: [number, number][] = [];
  private lastUrlWrite = 0;
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
    this.selectedId = url.vehicle;
    this.hidden = new Set(loadPref<string[]>("hiddenRoutes", []));

    this.vehicles = new VehicleLayer(map, kinematics.sizing);
    this.vehicles.selectedId = this.selectedId;
    this.rt = new RtClient({ data: opts.dataBase, api: opts.apiBase });
    // SeaBus: AIS fixes anchor the timetable (docs/skytrain-viz-PLAN.md §4.12).
    this.ais = new AisClient(opts.apiBase);
    // Schedule estimates for buses stop at stops, using the same travel-time profile as live prediction.
    store.pacerFor = (pp) => this.rt.predictorFor(pp)?.pacer;
    this.snapshot = this.buildSnapshot(this.clock.now());

    // Track infrastructure (optional: without it, SkyTrain falls back to GTFS shapes).
    void loadTracks(opts.dataBase, store.tracksPath).then((t) => {
      if (this.disposed) return;
      this.tracks = t;
      if (t) store.setTrackGraph(TrackGraph.fromCollection(t));
      this.syncStatic(true);
    });
    this.syncStatic(true);

    const onStyleLoad = () => {
      this.styleReady = true;
      this.ferryPair = undefined;
      this.syncStatic(true);
    };
    const onStyleData = () => {
      // A new style (theme switch) replaces our sources and layers; wait for it to load.
      if (!map.getSource(ROUTES_SOURCE)) this.styleReady = false;
    };
    const onClick = (e: { point: { x: number; y: number } }) => {
      const v = this.vehicles.pickAt(e.point.x, e.point.y);
      this.select(v?.id);
    };
    const onMouseMove = (e: { point: { x: number; y: number } }) => {
      map.getCanvas().style.cursor =
        this.vehicles.pickAt(e.point.x, e.point.y) ? "pointer" : "";
    };
    map.on("style.load", onStyleLoad);
    map.on("styledata", onStyleData);
    map.on("click", onClick);
    map.on("mousemove", onMouseMove);
    this.cleanups.push(() => {
      map.off("style.load", onStyleLoad);
      map.off("styledata", onStyleData);
      map.off("click", onClick);
      map.off("mousemove", onMouseMove);
      map.getCanvas().style.cursor = "";
    });

    const invalidate = () => {
      this.dirty = true;
    };
    this.cleanups.push(
      this.clock.subscribe(() => {
        this.dirty = true;
        this.writeUrl();
      }),
      store.onChange(() => {
        this.syncStatic();
        this.describers.clear();
        this.dirty = true;
      }),
      this.rt.onChange(invalidate),
      this.ais.onChange(invalidate),
    );

    this.raf = requestAnimationFrame(this.frame);
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
  seekDate(date: string): void {
    const t = this.clock.now();
    const sec = (t - serviceDayStart(displayServiceDate(t))) / 1000;
    this.clock.seek(serviceDayStart(date) + sec * 1000);
  }

  /** Seconds since the start of the displayed service day (the slider's value). */
  seekServiceSeconds(sec: number): void {
    const d = displayServiceDate(this.clock.now());
    this.clock.seek(serviceDayStart(d) + sec * 1000);
  }

  setRouteHidden(key: string, hidden: boolean): void {
    if (hidden) this.hidden.add(key);
    else this.hidden.delete(key);
    this.hidden = new Set(this.hidden); // a new identity for the snapshot
    savePref("hiddenRoutes", [...this.hidden]);
    if (this.styleReady) {
      applyRouteFilter(this.map, this.hidden);
      applyTrackFilter(this.map, this.hidden);
    }
    this.publish();
  }

  select(id: string | undefined): void {
    this.selectedId = this.vehicles.selectedId = id;
    this.writeUrl();
    this.publish();
  }

  /** Centre the map on the selected vehicle. */
  locateSelected(): void {
    const v = this.lastVehicles.find((x) => x.id === this.selectedId);
    if (v)
      this.map.easeTo({
        center: [v.lon, v.lat],
        zoom: Math.max(this.map.getZoom(), 15),
        duration: 600,
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
    for (const fn of this.cleanups) fn();
    this.rt.stop();
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

  private publish(): void {
    this.snapshot = this.buildSnapshot(this.clock.now());
    this.lastPublish = performance.now();
    this.dirty = false;
    for (const fn of this.listeners) fn();
  }

  private writeUrl(): void {
    if (!this.disposed) writeUrl(this.clock, this.selectedId);
  }

  private describeDate(date: string): string {
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
          return {
            id: this.selectedId,
            vehicle: v,
            route: v ? this.shownFeed?.routes.get(v.routeKey) : undefined,
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
      selected,
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
    };
  }

  /** Static layers follow the feed of the displayed date. */
  private syncStatic(force = false): void {
    const { map, store } = this;
    const pp = store.planFor(displayServiceDate(this.clock.now()));
    if (!pp || !this.styleReady || this.disposed) return;
    if (pp === this.shownFeed && !force) return;
    this.shownFeed = pp;
    addStaticLayers(map, pp.plan, this.theme, this.hidden);
    this.ferryPair = undefined;
    if (this.tracks) {
      addTrackLayers(map, this.tracks, pp.plan, this.theme, this.debug);
      applyTrackFilter(map, this.hidden);
      // Tracks replace the GTFS SkyTrain shapes.
      for (const id of ["routes-skytrain", "routes-skytrain-casing"])
        if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "none");
      if (this.debug) {
        const plan = pp.plan;
        const tracks = this.tracks;
        void loadPlatforms(this.store.dataBase, plan.feedVersion).then(
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
    this.dirty = true;
  }

  private frame = (): void => {
    if (this.disposed) return;
    const { store, rt, ais, clock, map } = this;
    const t = clock.now();
    const visible =
      this.hidden.size ?
        new Set(routeKeys(this.shownFeed).filter((k) => !this.hidden.has(k)))
      : undefined;
    // Scenarios are hypothetical: never mix in real bus positions.
    if (!store.scenario) rt.update(t);
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
    if (live.vehicles) {
      // RT buses, plus estimates for buses whose RT prediction has run out (unreported for a while)
      // but whose delay is known, unless the same bus (block) is already shown from RT.
      const shownBlocks = new Set(
        live.vehicles.map((v) => pp?.tripIndex.get(v.tripId)?.vehicleId),
      );
      const carried = scheduled.filter(
        (v) =>
          v.mode === "bus"
          && carry?.carried.has(v.tripId)
          && !shownBlocks.has(v.id),
      );
      this.lastVehicles = [
        ...scheduled.filter((v) => v.mode !== "bus"),
        ...live.vehicles,
        ...carried,
      ];
    } else this.lastVehicles = scheduled;
    store.setLiveDispatch(rt.dispatchPointer());

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
    if (performance.now() - this.lastCoverageUpdate > 1000) {
      this.lastCoverageUpdate = performance.now();
      const [lo, hi] = this.sliderRange(t);
      const next = rt.coverageFor(lo, hi);
      if (JSON.stringify(next) !== JSON.stringify(this.coverage)) {
        this.coverage = next;
        this.dirty = true;
      }
    }
    this.datasets = this.datasetsDrawn(live.vehicles?.length ?? 0, aisUsed);

    if (this.styleReady)
      this.vehicles.update(this.lastVehicles, this.theme === "dark");
    this.syncStatic();

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

  /** What the map shows right now, for the attribution control (V2-PLAN.md §4.6). */
  private datasetsDrawn(rtVehicles: number, aisUsed: boolean): string[] {
    const out: string[] = [];
    const routesShown = routeKeys(this.shownFeed).some(
      (k) => !this.hidden.has(k),
    );
    if (routesShown || this.lastVehicles.length) out.push("translink-gtfs");
    if (rtVehicles > 0) out.push("translink-gtfs-rt");
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
