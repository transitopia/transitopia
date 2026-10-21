// Loads the feed manifest and service plans on demand, and answers "which vehicles exist at instant t"
// by querying the service days that can have trips running then (today, and yesterday's after-midnight
// trips), each against the feed that covers that date.

import type { TrackGraph } from "@transitopia/transit-core/infra/graph.ts";
import { TrainPlayback } from "@transitopia/transit-core/movement/playback.ts";
import {
  serviceKey,
  type MovementsFile,
  type MovementsIndex,
} from "@transitopia/transit-core/movement/types.ts";
import {
  reconcileScheduled,
  type ScheduledCorrections,
} from "@transitopia/transit-core/corrections/reconcile.ts";
import {
  applyPatch,
  type DispatchIndex,
  type DispatchPatch,
} from "@transitopia/transit-core/dispatch/patch.ts";
import type {
  Observation,
  ObservationFile,
  ObservationIndex,
} from "@transitopia/transit-core/corrections/types.ts";
import type { PlacesFile, PlacesIndex } from "@transitopia/shared/features.ts";
import { hubsFromPlaces } from "./hubs.ts";
import { type BusHub } from "@transitopia/transit-core/plan/exchanges.ts";
import type { ScenarioManifest } from "@transitopia/transit-core/scenario/types.ts";
import {
  preparePlan,
  scheduledVehicles,
  withServiceTrips,
  type PreparedPlan,
  type ScheduleCorrections,
  type TripPacer,
  type VehicleState,
} from "@transitopia/transit-core/schedule/engine.ts";
import {
  feedDataPath,
  feedForDate,
  manifestRange,
  patternStarts,
  regionDataPath,
  type FeedManifest,
  type FeedManifestEntry,
  type PlanCorridorRefs,
  type PlanFiles,
  type PlanTrip,
  type ServicePlan,
  type TripFileRef,
} from "@transitopia/transit-core/plan/types.ts";
import {
  decodeCore,
  decodeCorridorInfo,
  decodeCorridorRefs,
  decodeShapes,
  decodeTrips,
  railTripFiles,
  tripFilesFor,
  type PublishedCorridorInfo,
  type PublishedCorridorRefs,
  type PublishedPlan,
  type PublishedShapes,
  type PublishedTrips,
} from "@transitopia/transit-core/plan/published.ts";
import { activeServices } from "@transitopia/transit-core/gtfs/calendar.ts";
import {
  addDays,
  localDate,
  serviceDayStart,
  type ServiceDate,
} from "@transitopia/transit-core/time.ts";
import type { VersionPointer } from "@transitopia/transit-core/rt/live.ts";
import type { RegionConfig } from "./config.ts";

/** Trip files arriving within this long of each other are added to the prepared plan at once (ms). */
const TRIPS_BATCH_MS = 20;
/**
 * A plan that failed to load is tried again after this long, doubling with each failure up to
 * RETRY_MAX_MS: planFor is called on every redraw, so retrying at once would download it in a loop.
 */
const RETRY_FIRST_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;

/** A feed version's plan as loaded so far (packages/transit-core/DESIGN.md#published-plans). */
interface LoadedVersion {
  /** Its plan.json's directory (relative to the data root, ending in "/"), which its files are relative to. */
  dir: string;
  files: PlanFiles;
  /** The prepared plan with every trip file loaded so far. */
  pp: PreparedPlan;
  /** Trip files by path: loading, or done (loaded, or failed: their trips are missing, as before). */
  tripFiles: Map<string, "loading" | "done">;
  /** Each service's trips loaded so far. */
  byService: Map<string, PlanTrip[]>;
  /** Services with trips loaded since the prepared plan was made, until `flush` adds them. */
  pending: Set<string>;
  flush: ReturnType<typeof setTimeout> | undefined;
}

export class PlanStore {
  private versions = new Map<string, LoadedVersion>();
  private loading = new Map<string, Promise<void>>();
  /** Feed versions whose plan failed to load: when to try again, and the wait after that. */
  private failed = new Map<string, { at: number; wait: number }>();
  private checkingManifest = false;
  /**
   * Whether the data has been rebuilt since this store's manifest: its files are then another
   * build's, so the store can't load them (`checkManifest`). The engine is made again then.
   */
  get rebuilt(): boolean {
    return this.isRebuilt;
  }
  private isRebuilt = false;
  /** Trip files requested with their plan's core, by path, until loadTrips takes them. */
  private prefetched = new Map<string, Promise<PublishedTrips>>();
  private listeners = new Set<() => void>();
  private graph: TrackGraph | undefined;
  private movementIndexes = new Map<string, MovementsIndex | null>();
  /** The feed's places index (data/feeds/<feed>/places.json) and files, by path. */
  private placesIndex = new Map<string, PlacesIndex | null>();
  private placesFiles = new Map<string, PlacesFile | null>();
  /** Each plan version's corridor refs, once asked for (`corridorRefsFor`). */
  private corridorRefs = new Map<string, PlanCorridorRefs | null>();
  private movementFiles = new Map<string, MovementsFile | null>();
  private playbacks = new Map<string, TrainPlayback>();
  private preview: Record<string, string> = {};
  private dispatchIndex: DispatchIndex | null | undefined;
  /** Live dispatch versions (the RT service), which take precedence over the static index. */
  private liveDispatch: DispatchIndex["byDate"] = {};
  private patches = new Map<string, DispatchPatch | null>();
  private pending = new Set<string>();
  private observationIndex: ObservationIndex | null | undefined;
  private observationFiles = new Map<string, Observation[] | null>();
  private reconciledScheduled = new Map<
    string,
    ScheduledCorrections | undefined
  >();

  readonly manifest: FeedManifest;
  /** Set when viewing a scenario (?scenario=<name>). */
  readonly scenario: ScenarioManifest | undefined;
  /** URL prefix of the published data (manifest paths are relative to it), ending in "/". */
  readonly dataBase: string;
  /** URL prefix of the RT service, or undefined for schedules only. */
  private readonly apiBase: string | undefined;
  /** The region's id: its published files are under regionDataPath(region). */
  readonly region: string;
  private readonly config: Pick<
    RegionConfig,
    "kinematics" | "operations" | "feed"
  >;

  private constructor(
    manifest: FeedManifest,
    base: string,
    apiBase: string | undefined,
    region: string,
    config: Pick<RegionConfig, "kinematics" | "operations" | "feed">,
    scenario?: ScenarioManifest,
  ) {
    this.manifest = manifest;
    this.dataBase = base;
    this.apiBase = apiBase;
    this.region = region;
    this.config = config;
    this.scenario = scenario;
  }

  /**
   * The URL of a published file (a path from a manifest or index, under dataBase), with the build
   * it's from: every data build republishes files at the same paths, cached for a day, so the URL
   * names the build (the manifest's generatedAt, which changes with every build; the manifest
   * itself is cached for 5 minutes) and a rebuilt file is never read from a cache as its old self
   * (deployment/README.md#transit-data-datatransitopiaorg).
   */
  dataUrl(path: string): string {
    return `${this.dataBase}${path}?v=${encodeURIComponent(this.manifest.generatedAt)}`;
  }

  /** Whether the region has track-level rail, and with it tracks, movements, dispatch and observations. */
  get rail(): boolean {
    return this.config.operations !== undefined;
  }

  /** Enable track-level SkyTrain playback (movement files need the track graph). */
  setTrackGraph(g: TrackGraph): void {
    this.graph = g;
    this.emit();
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  private fetchOnce<T>(
    key: string,
    url: string,
    store: Map<string, T | null>,
    make: (json: unknown) => T,
  ): void {
    if (store.has(key) || this.pending.has(key)) return;
    this.pending.add(key);
    void fetch(url)
      .then(async (r) => (r.ok ? make(await r.json()) : null))
      .catch(() => null)
      .then((v) => {
        store.set(key, v);
        this.pending.delete(key);
        this.emit();
      });
  }

  /** Observations for a service date (empty until loaded or if there are none). */
  private observationsFor(date: ServiceDate): Observation[] | undefined {
    // Only the rail region publishes observations so far.
    if (!this.rail) return [];
    if (this.observationIndex === undefined) {
      this.observationIndex = null;
      void fetch(
        this.dataUrl(regionDataPath(this.region, "observations/index.json")),
      )
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)
        .then((idx) => {
          this.observationIndex = idx as ObservationIndex | null;
          this.emit();
        });
      return undefined;
    }
    const paths = this.observationIndex?.byDate[date];
    if (!paths?.length) return [];
    const out: Observation[] = [];
    for (const path of paths) {
      const obs = this.observationFiles.get(path);
      if (obs === undefined) {
        this.fetchOnce(
          path,
          this.dataUrl(path),
          this.observationFiles,
          (j) => (j as ObservationFile).observations,
        );
        return undefined;
      }
      if (obs) out.push(...obs);
    }
    return out;
  }

  /**
   * The dispatch patch for a date (observations, disruptions; packages/transit-core/DESIGN.md#dispatcher): null if there is
   * none, undefined while loading. Patches are dispatched centrally, never in the browser.
   */
  private patchFor(date: ServiceDate): DispatchPatch | null | undefined {
    if (!this.rail) return null;
    if (this.dispatchIndex === undefined) {
      this.dispatchIndex = null;
      const get = (url: string) =>
        fetch(url)
          .then((r) => (r.ok ? (r.json() as Promise<DispatchIndex>) : null))
          .catch(() => null);
      // The static index (build:dispatch) and, unless viewing a scenario, the live one.
      void Promise.all([
        get(this.dataUrl(regionDataPath(this.region, "dispatch/index.json"))),
        this.scenario || !this.apiBase ?
          null
        : get(`${this.apiBase}rt/dispatch`),
      ]).then(([idx, live]) => {
        this.dispatchIndex = idx ?? { schema: 1, byDate: {} };
        if (live) this.liveDispatch = { ...live.byDate, ...this.liveDispatch };
        this.emit();
      });
      return undefined;
    }
    const preview = this.preview[date];
    const entry =
      preview ?
        { version: preview, path: `rt/dispatch/${date}/${preview}.json` }
      : (this.liveDispatch[date] ?? this.dispatchIndex?.byDate[date]);
    if (!entry) return this.dispatchIndex ? null : undefined;
    const key = `${date}|${entry.version}`;
    const p = this.patches.get(key);
    if (p === undefined) {
      this.fetchOnce(
        key,
        // Live and preview versions are served by the RT service, static ones with the data.
        entry.path.startsWith("rt/") && this.apiBase ?
          `${this.apiBase}${entry.path}`
        : this.dataUrl(entry.path),
        this.patches,
        (j) => {
          const patch = j as DispatchPatch;
          for (const u of patch.unmatched)
            console.warn(`Observation not applied (${u.reason}):`, u.obs);
          for (const pr of patch.problems ?? [])
            console.warn(`Disruption not fully applied: ${pr}`);
          return patch;
        },
      );
      return undefined;
    }
    return p;
  }

  /** Observations applied to a date's timetable vehicles (SeaBus, WCE, buses), cached. */
  private scheduledCorrectionsFor(
    date: ServiceDate,
    pp: PreparedPlan,
  ): ScheduledCorrections | undefined {
    const obs = this.observationsFor(date);
    if (!obs?.length) return undefined;
    const key = `${date}|${pp.plan.feedVersion}`;
    if (!this.reconciledScheduled.has(key)) {
      const r = reconcileScheduled(pp, obs, date);
      for (const u of r.unmatched)
        console.warn(`Observation not applied (${u.reason}):`, u.obs);
      this.reconciledScheduled.set(
        key,
        r.trips.size || r.cancelled.size || r.consists.size ? r : undefined,
      );
    }
    return this.reconciledScheduled.get(key);
  }

  /**
   * A loaded plan's corridor refs (`PlanCorridorRefs`: the patterns along each corridor), for
   * drawing a stretch of a pattern over its corridors (a combined route,
   * packages/transit-map/README.md#route-focus). Loaded only when first asked for: undefined while
   * it loads (a change event fires), null when the plan has none.
   */
  corridorRefsFor(pp: PreparedPlan): PlanCorridorRefs | null | undefined {
    const v = this.versions.get(pp.plan.feedVersion);
    if (!v?.files.corridorRefs) return null;
    const key = `corridor-refs:${pp.plan.feedVersion}`;
    this.fetchOnce(
      key,
      this.dataUrl(v.dir + v.files.corridorRefs),
      this.corridorRefs,
      (j) => decodeCorridorRefs(j as PublishedCorridorRefs),
    );
    return this.corridorRefs.get(key);
  }

  /**
   * A plan version's places file (docs/DESIGN.md#published-features): the registry's IDs for its
   * stations, stops and routes. Undefined while it loads (a change event fires), null when there's
   * none (no registry where the data was built, or a version not reconciled yet).
   */
  placesFor(pp: PreparedPlan): PlacesFile | null | undefined {
    if (this.scenario) return null;
    const indexPath = feedDataPath(
      this.config.feed.id,
      undefined,
      "places.json",
    );
    // The index changes with admin edits, not only builds: no build parameter (a short cache).
    this.fetchOnce(
      "places:index",
      `${this.dataBase}${indexPath}`,
      this.placesIndex,
      (j) => j as PlacesIndex,
    );
    const index = this.placesIndex.get("places:index");
    if (index === undefined) return undefined;
    const path = index?.versions[pp.plan.feedVersion];
    if (!path) return null;
    // Each file is immutable.
    this.fetchOnce(
      `places:${path}`,
      `${this.dataBase}${path}`,
      this.placesFiles,
      (j) => j as PlacesFile,
    );
    const file = this.placesFiles.get(`places:${path}`);
    if (file) placesOfPlan.set(pp.plan, file);
    return file;
  }

  /** Track-level playback for a service date, or undefined (not built / still loading). */
  private playbackFor(
    date: ServiceDate,
    pp: PreparedPlan,
    fromSec: number,
  ): TrainPlayback | undefined {
    if (!this.graph) return undefined;
    const version = pp.plan.feedVersion;
    // Its movement file references every SkyTrain trip of the date's services: build it only while
    // its trains can still be running (the day before, early on), once those trips are in.
    const v = this.versions.get(version);
    if (!v) return undefined;
    const railFiles = railTripFiles(v.files, pp.servicesOn(date));
    if (!railFiles.some((f) => f.until > fromSec)) return undefined;
    let loaded = true;
    for (const ref of railFiles) {
      const state = v.tripFiles.get(ref.path);
      if (state === undefined) this.loadTrips(v, ref);
      if (state !== "done" || v.pending.has(ref.service)) loaded = false;
    }
    if (!loaded) return undefined;
    const index = this.movementIndexes.get(version);
    if (index === undefined) {
      const entry = this.manifest.feeds.find((f) => f.version === version);
      const url = this.dataUrl(
        entry?.movements
          ?? feedDataPath(this.config.feed.id, version, "movements/index.json"),
      );
      this.fetchOnce(
        version,
        url,
        this.movementIndexes,
        (j) => j as MovementsIndex,
      );
      return undefined;
    }
    if (!index) return undefined;
    const rail = railServices(pp);
    const key = serviceKey([...pp.servicesOn(date)].filter((s) => rail.has(s)));
    const path = index.files[key];
    if (!path) return undefined;
    const fileKey = `${version}|${key}`;
    const file = this.movementFiles.get(fileKey);
    if (file === undefined) {
      this.fetchOnce(
        fileKey,
        this.dataUrl(path),
        this.movementFiles,
        (j) => j as MovementsFile,
      );
      return undefined;
    }
    if (!file) return undefined;
    // The date's own plan when a patch applies to this base, else the base plan.
    const patch = this.patchFor(date);
    if (patch === undefined) return undefined;
    const usable =
      patch
      && patch.feedVersion === file.feedVersion
      && patch.baseBuiltAt === file.builtAt;
    const pbKey = usable ? `${fileKey}|${date}|${patch.version}` : fileKey;
    let pb = this.playbacks.get(pbKey);
    if (!pb) {
      pb = new TrainPlayback(
        usable ? applyPatch(file, patch) : file,
        pp,
        this.graph,
        this.config.kinematics,
        {
          deadheadSpeedFactor: this.config.operations!.yard.deadheadSpeedFactor,
          turnbackSpeedFactor: this.config.operations!.turnback.speedFactor,
          shapes: true,
        },
      );
      this.playbacks.set(pbKey, pb);
    }
    return pb;
  }

  /**
   * Show these dispatch versions (service date → version) instead of the current ones: previews of
   * corrections not confirmed yet (docs/DESIGN.md#corrections-and-previews, ?preview=<YYYYMMDD>:<version>).
   */
  setPreview(versions: Record<string, string>): void {
    this.preview = { ...versions };
    this.emit();
  }

  /** Dates shown with a preview version. */
  get previewDates(): string[] {
    return Object.keys(this.preview).sort();
  }

  /** New live dispatch versions from the live endpoint (service date → version and path). */
  setLiveDispatch(pointer: Record<string, VersionPointer> | undefined): void {
    if (!pointer || this.scenario) return;
    let changed = false;
    for (const [date, entry] of Object.entries(pointer)) {
      if (this.liveDispatch[date]?.version === entry.version) continue;
      this.liveDispatch[date] = { version: entry.version, path: entry.path };
      changed = true;
    }
    if (changed) this.emit();
  }

  /** Disruptions in effect at instant t (epoch ms), from the dispatch patches of the days running then. */
  noticesAt(t: number): string[] {
    const out: string[] = [];
    const today = localDate(t);
    for (const date of [addDays(today, -1), today]) {
      const sec = (t - serviceDayStart(date)) / 1000;
      const patch = this.patchFor(date);
      for (const n of patch?.notices ?? [])
        if (sec >= n.from && sec <= n.to) out.push(`${n.text} (${n.source})`);
    }
    return out;
  }

  static async load(
    base: string,
    apiBase: string | undefined,
    region: string,
    config: Pick<RegionConfig, "kinematics" | "operations" | "feed">,
    scenario?: string,
  ): Promise<PlanStore> {
    if (scenario) {
      const res = await fetch(
        `${base}${regionDataPath(region, `scenarios/${encodeURIComponent(scenario)}/manifest.json`)}`,
      );
      if (!res.ok)
        throw new Error(
          `Scenario "${scenario}" isn't built (HTTP ${res.status}). Run "npm run scenario -- ${scenario}".`,
        );
      const sm = (await res.json()) as ScenarioManifest;
      return new PlanStore(
        { schema: 1, generatedAt: sm.builtAt, feeds: sm.feeds },
        base,
        apiBase,
        region,
        config,
        sm,
      );
    }
    const res = await fetchManifest(base, config.feed.id);
    if (!res.ok)
      throw new Error(
        `No timetable data (HTTP ${res.status}). Run "npm run data" first.`,
      );
    return new PlanStore(
      (await res.json()) as FeedManifest,
      base,
      apiBase,
      region,
      config,
    );
  }

  /** Track network to draw and route on, in a region with track-level rail. */
  get tracksPath(): string | undefined {
    if (!this.rail) return undefined;
    return (
      this.scenario?.tracks
      ?? regionDataPath(this.region, "infra/tracks.geojson")
    );
  }

  /** Instants covered by the available feeds: first service day start to end of last service day. */
  range(): [number, number] | undefined {
    const r = manifestRange(this.manifest);
    if (!r) return undefined;
    return [
      serviceDayStart(r.start),
      serviceDayStart(addDays(r.end, 1)) + 4 * 3600_000,
    ];
  }

  /**
   * Prepared plan for a service date, with the trips of its services shown from `fromSec` on
   * (service seconds: the day before needs only its late trips; Infinity for none, only the core),
   * or undefined while they load (a change event fires when they're in). The same feed version's
   * plan object (`pp.plan`) stays the same; the prepared plan is a new object whenever trips arrive.
   */
  planFor(date: ServiceDate, fromSec = 0): PreparedPlan | undefined {
    const feed = feedForDate(this.manifest, date);
    if (!feed) return undefined;
    const v = this.versions.get(feed.version);
    if (!v) {
      this.loadVersion(feed, date, fromSec);
      return undefined;
    }
    let ready = true;
    for (const ref of tripFilesFor(v.files, v.pp.servicesOn(date), fromSec)) {
      const state = v.tripFiles.get(ref.path);
      if (state === undefined) this.loadTrips(v, ref);
      // Done once its trips are in the prepared plan.
      if (state !== "done" || v.pending.has(ref.service)) ready = false;
    }
    return ready ? v.pp : undefined;
  }

  /** A published file, parsed. */
  private async getJson<T>(path: string): Promise<T> {
    const r = await fetch(this.dataUrl(path));
    if (!r.ok) throw new Error(`Failed to load ${path}: HTTP ${r.status}`);
    return r.json() as Promise<T>;
  }

  /**
   * The plan's core and what it's drawn with besides its tiles: shapes (vehicles move along them)
   * and the corridors' metadata. The trip files the date asking for it needs start loading with them.
   */
  private loadVersion(
    feed: FeedManifestEntry,
    date: ServiceDate,
    fromSec: number,
  ): void {
    if (this.loading.has(feed.version)) return;
    const failed = this.failed.get(feed.version);
    if (failed && Date.now() < failed.at) return;
    const dir = feed.path.slice(0, feed.path.lastIndexOf("/") + 1);
    const get = <T>(path: string) => this.getJson<T>(path);
    const promise = get<PublishedPlan>(feed.path)
      .then(async (core) => {
        const { files } = core;
        for (const ref of tripFilesFor(
          files,
          activeServices(core.calendar, date),
          fromSec,
        )) {
          const trips = get<PublishedTrips>(dir + ref.path);
          // Handled when loadTrips takes it.
          trips.catch(() => {});
          this.prefetched.set(dir + ref.path, trips);
        }
        if (!files.tiles)
          throw new Error(
            `The plan for ${feed.version} has no tiles: run "npm run build:plan-tiles"`,
          );
        const [shapes, info] = await Promise.all([
          get<PublishedShapes>(dir + files.shapes),
          files.corridorInfo ?
            get<PublishedCorridorInfo>(dir + files.corridorInfo)
          : undefined,
        ]);
        const plan = decodeCore(core);
        plan.shapes = decodeShapes(shapes);
        if (info) plan.corridorInfo = decodeCorridorInfo(info);
        this.versions.set(feed.version, {
          dir,
          files,
          pp: preparePlan(plan, this.config.kinematics),
          tripFiles: new Map(),
          byService: new Map(),
          pending: new Set(),
          flush: undefined,
        });
        this.loading.delete(feed.version);
        this.failed.delete(feed.version);
        this.emit();
      })
      .catch((e: unknown) => {
        console.error(e);
        void this.checkManifest();
        const wait =
          failed ? Math.min(failed.wait * 2, RETRY_MAX_MS) : RETRY_FIRST_MS;
        this.failed.set(feed.version, { at: Date.now() + wait, wait });
        this.loading.delete(feed.version);
      });
    this.loading.set(feed.version, promise);
  }

  /**
   * After a plan failed to load: whether the manifest has changed since this store read it. A tab
   * open across a data build asks for files with the old build in their URL (`dataUrl`), which
   * caches may answer with the old build's files, in a format this code may not read.
   */
  private async checkManifest(): Promise<void> {
    if (this.scenario || this.isRebuilt || this.checkingManifest) return;
    this.checkingManifest = true;
    try {
      const res = await fetchManifest(this.dataBase, this.config.feed.id);
      const m = res.ok ? ((await res.json()) as FeedManifest) : undefined;
      if (m && m.generatedAt !== this.manifest.generatedAt) {
        this.isRebuilt = true;
        this.emit();
      }
    } catch {
      // Offline, or a broken manifest: the plan is tried again later.
    } finally {
      this.checkingManifest = false;
    }
  }

  /** A file of a service's trips, added to the prepared plan when it's in. */
  private loadTrips(v: LoadedVersion, ref: TripFileRef): void {
    v.tripFiles.set(ref.path, "loading");
    const path = v.dir + ref.path;
    const json =
      this.prefetched.get(path) ?? this.getJson<PublishedTrips>(path);
    this.prefetched.delete(path);
    void json
      .then(decodeTrips)
      .catch((e: unknown) => {
        console.error(e);
        return null;
      })
      .then((trips) => {
        v.tripFiles.set(ref.path, "done");
        if (trips?.length) {
          v.byService.set(ref.service, [
            ...(v.byService.get(ref.service) ?? []),
            ...trips,
          ]);
          v.pp.plan.trips.push(...trips);
          v.pending.add(ref.service);
        }
        // Files arriving together are prepared together (each pass copies the trip index).
        v.flush ??= setTimeout(() => {
          v.flush = undefined;
          if (v.pending.size)
            v.pp = withServiceTrips(
              v.pp,
              new Map([...v.pending].map((s) => [s, v.byService.get(s)!])),
              this.config.kinematics,
            );
          v.pending.clear();
          this.emit();
        }, TRIPS_BATCH_MS);
      });
  }

  /**
   * The URL of a loaded plan's tiles, for a MapLibre vector source (the pmtiles protocol): named by
   * their content, so without the build in it (`dataUrl`).
   */
  tilesUrl(pp: PreparedPlan): string | undefined {
    const v = this.versions.get(pp.plan.feedVersion);
    if (!v?.files.tiles) return undefined;
    return `pmtiles://${new URL(this.dataBase + v.dir + v.files.tiles, location.href).href}`;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Vehicles at instant t (epoch ms): SkyTrain from track-level playback where movement files exist,
   * everything else (and SkyTrain as a fallback) from the schedule engine.
   */
  /** Paces scheduled trips between timetable times (buses: learned stops and slow sections); set by the app. */
  pacerFor: ((pp: PreparedPlan) => TripPacer | undefined) | undefined;

  private pacing(pp: PreparedPlan): { pacer?: TripPacer } {
    const pacer = this.pacerFor?.(pp);
    return pacer ? { pacer } : {};
  }

  /**
   * @param rtCorrections RT delays carried into schedule estimates, per service date; observations
   *   (sightings) take precedence for the trips they cover.
   */
  vehiclesAt(
    t: number,
    routes?: Set<string>,
    rtCorrections?: Map<ServiceDate, ScheduleCorrections>,
  ): VehicleState[] {
    const today = localDate(t);
    const out: VehicleState[] = [];
    for (const date of [addDays(today, -1), today]) {
      const sec = (t - serviceDayStart(date)) / 1000;
      if (sec < 0) continue;
      // The day before: only its trips still running.
      const pp = this.planFor(date, date === today ? 0 : sec);
      if (!pp) continue;
      const pb = this.playbackFor(date, pp, date === today ? 0 : sec);
      if (pb) {
        out.push(...pb.vehiclesAt(sec, date, routes));
        const nonRail = new Set(
          [...(routes ?? pp.routes.keys())].filter(
            (k) => pp.routes.get(k)?.kind !== "skytrain",
          ),
        );
        out.push(
          ...scheduledVehicles(
            pp,
            { serviceDate: date, sec, routes: nonRail, ...this.pacing(pp) },
            mergeCorrections(
              this.scheduledCorrectionsFor(date, pp),
              rtCorrections?.get(date),
            ),
          ),
        );
      } else
        out.push(
          ...scheduledVehicles(
            pp,
            { serviceDate: date, sec, routes, ...this.pacing(pp) },
            mergeCorrections(
              this.scheduledCorrectionsFor(date, pp),
              rtCorrections?.get(date),
            ),
          ),
        );
    }
    return out;
  }
}

const merged = new WeakMap<
  ScheduleCorrections,
  WeakMap<ScheduleCorrections, ScheduleCorrections>
>();
/**
 * Corrections from two sources, the first taking precedence per trip, cancelled by either (cached, so
 * the engine's per-object caches hold).
 */
export function mergeCorrections(
  obs: ScheduleCorrections | undefined,
  rt: ScheduleCorrections | undefined,
): ScheduleCorrections | undefined {
  if (!obs || !rt) return obs ?? rt;
  let inner = merged.get(obs);
  if (!inner) merged.set(obs, (inner = new WeakMap()));
  let m = inner.get(rt);
  if (!m) {
    m = {
      trips: new Map([...rt.trips, ...obs.trips]),
      cancelled:
        rt.cancelled.size ?
          new Set([...obs.cancelled, ...rt.cancelled])
        : obs.cancelled,
      consists: new Map([...rt.consists, ...obs.consists]),
    };
    const shapes = obs.shapes ?? rt.shapes;
    if (shapes) m.shapes = shapes;
    inner.set(rt, m);
  }
  return m;
}

/**
 * The service date shown in the UI for an instant: times before 03:00 belong to the previous
 * service day, matching how the timetable (and riders) think about late-night trips.
 */
export const SERVICE_DAY_ROLLOVER_H = 3;
export function displayServiceDate(t: number): ServiceDate {
  return localDate(t - SERVICE_DAY_ROLLOVER_H * 3600_000);
}

/** Each plan's places file, once loaded (`PlanStore.placesFor`). */
const placesOfPlan = new WeakMap<ServicePlan, PlacesFile>();
const hubCache = new WeakMap<
  ServicePlan,
  { places: PlacesFile | undefined; hubs: BusHub[] }
>();
/**
 * The plan's bus exchanges and stations' bus bays: as its places file groups them once it's loaded
 * (src/hubs.ts), else the plan's own grouping. A new array when the places file arrives.
 */
export function hubsOf(plan: ServicePlan): BusHub[] {
  const places = placesOfPlan.get(plan);
  let c = hubCache.get(plan);
  if (!c || c.places !== places)
    hubCache.set(
      plan,
      (c = {
        places,
        // A plan published before plans carried `hubs` (until the next data build after a deploy,
        // and in branch previews, which read production's data) has none: no exchanges, no crash.
        hubs: places ? hubsFromPlaces(plan, places) : (plan.hubs ?? []),
      }),
    );
  return c.hubs;
}

const railServiceCache = new WeakMap<ServicePlan, Set<string>>();
/** Service ids with SkyTrain trips (movement files are keyed by these only). */
function railServices(pp: PreparedPlan): Set<string> {
  let s = railServiceCache.get(pp.plan);
  if (!s) {
    const starts = patternStarts(pp.plan);
    s = new Set(
      pp.plan.patterns
        .filter((p) => pp.routes.get(p.route)?.kind === "skytrain")
        .flatMap((p) => Object.keys(starts[p.id]!)),
    );
    railServiceCache.set(pp.plan, s);
  }
  return s;
}

/**
 * A feed's manifest, revalidated rather than taken from the browser's cache: it names the build
 * every other file's URL is for.
 */
function fetchManifest(base: string, feed: string): Promise<Response> {
  return fetch(`${base}${feedDataPath(feed, undefined, "manifest.json")}`, {
    cache: "no-cache",
  });
}
