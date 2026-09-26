// Loads the feed manifest and service plans on demand, and answers "which vehicles exist at instant t"
// by querying the service days that can have trips running then (today, and yesterday's after-midnight
// trips), each against the feed that covers that date.

import kinematicsConfig from '../../data/config/kinematics.json';
import operationsConfig from '../../data/config/operations.json';
import type { TrackGraph } from '../core/infra/graph.ts';
import { TrainPlayback } from '../core/movement/playback.ts';
import { serviceKey, type MovementsFile, type MovementsIndex } from '../core/movement/types.ts';
import { reconcile, reconcileScheduled, type ReconcileResult, type ScheduledCorrections } from '../core/corrections/reconcile.ts';
import type { Observation, ObservationFile, ObservationIndex } from '../core/corrections/types.ts';
import type { ScenarioManifest } from '../core/scenario/types.ts';
import { preparePlan, scheduledVehicles, type PreparedPlan, type VehicleState } from '../core/schedule/engine.ts';
import { feedForDate, manifestRange, type FeedManifest, type ServicePlan } from '../core/plan/types.ts';
import { addDays, localDate, serviceDayStart } from '../core/time.ts';
import type { KinematicsConfig } from '../core/movement/kinematics.ts';

export const kinematics = kinematicsConfig as unknown as KinematicsConfig;

const BASE = import.meta.env.BASE_URL;

export class PlanStore {
  private prepared = new Map<string, PreparedPlan>();
  private loading = new Map<string, Promise<PreparedPlan>>();
  private listeners = new Set<() => void>();
  private graph: TrackGraph | undefined;
  private movementIndexes = new Map<string, MovementsIndex | null>();
  private playbacks = new Map<string, TrainPlayback | null>();
  private pending = new Set<string>();
  private observationIndex: ObservationIndex | null | undefined;
  private observationFiles = new Map<string, Observation[] | null>();
  private reconciled = new Map<string, ReconcileResult>();
  private reconciledScheduled = new Map<string, ScheduledCorrections | undefined>();

  private constructor(
    readonly manifest: FeedManifest,
    /** Set when viewing a scenario (?scenario=<name>). */
    readonly scenario?: ScenarioManifest,
  ) {}

  /** Enable track-level SkyTrain playback (movement files need the track graph). */
  setTrackGraph(g: TrackGraph): void {
    this.graph = g;
    this.emit();
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  private fetchOnce<T>(key: string, url: string, store: Map<string, T | null>, make: (json: unknown) => T): void {
    if (store.has(key) || this.pending.has(key)) return;
    this.pending.add(key);
    fetch(url)
      .then(async (r) => (r.ok ? make(await r.json()) : null))
      .catch(() => null)
      .then((v) => {
        store.set(key, v);
        this.pending.delete(key);
        this.emit();
      });
  }

  /** Observations for a service date (empty until loaded or if there are none). */
  private observationsFor(date: string): Observation[] | undefined {
    if (this.observationIndex === undefined) {
      this.observationIndex = null;
      fetch(`${BASE}data/observations/index.json`)
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
        this.fetchOnce(path, `${BASE}${path}`, this.observationFiles, (j) => (j as ObservationFile).observations);
        return undefined;
      }
      if (obs) out.push(...obs);
    }
    return out;
  }

  /** Observations reconciled with a date's inferred runs (cached). */
  private correctionsFor(date: string, pb: TrainPlayback, pp: PreparedPlan): ReconcileResult | undefined {
    const obs = this.observationsFor(date);
    if (!obs?.length) return undefined;
    const key = `${date}|${pb.file.feedVersion}|${pb.file.services.join('+')}`;
    let r = this.reconciled.get(key);
    if (!r) {
      r = reconcile(pb.file, pp, obs, date);
      for (const u of r.unmatched) console.warn(`Observation not applied (${u.reason}):`, u.obs);
      this.reconciled.set(key, r);
    }
    return r;
  }

  /** Observations applied to a date's timetable vehicles (SeaBus, WCE, buses), cached. */
  private scheduledCorrectionsFor(date: string, pp: PreparedPlan): ScheduledCorrections | undefined {
    const obs = this.observationsFor(date);
    if (!obs?.length) return undefined;
    const key = `${date}|${pp.plan.feedVersion}`;
    if (!this.reconciledScheduled.has(key)) {
      const r = reconcileScheduled(pp, obs, date);
      for (const u of r.unmatched) console.warn(`Observation not applied (${u.reason}):`, u.obs);
      this.reconciledScheduled.set(key, r.trips.size || r.cancelled.size || r.consists.size ? r : undefined);
    }
    return this.reconciledScheduled.get(key);
  }

  /** Track-level playback for a service date, or undefined (not built / still loading). */
  private playbackFor(date: string, pp: PreparedPlan): TrainPlayback | undefined {
    if (!this.graph) return undefined;
    const version = pp.plan.feedVersion;
    const index = this.movementIndexes.get(version);
    if (index === undefined) {
      const entry = this.manifest.feeds.find((f) => f.version === version);
      const url = `${BASE}${entry?.movements ?? `data/feeds/${version}/movements/index.json`}`;
      this.fetchOnce(version, url, this.movementIndexes, (j) => j as MovementsIndex);
      return undefined;
    }
    if (!index) return undefined;
    const rail = railServices(pp);
    const key = serviceKey([...pp.servicesOn(date)].filter((s) => rail.has(s)));
    const path = index.files[key];
    if (!path) return undefined;
    const pbKey = `${version}|${key}`;
    const pb = this.playbacks.get(pbKey);
    if (pb === undefined) {
      const g = this.graph;
      this.fetchOnce(pbKey, `${BASE}${path}`, this.playbacks, (j) => new TrainPlayback(j as MovementsFile, pp, g, kinematics, {
        deadheadSpeedFactor: operationsConfig.yard.deadheadSpeedFactor,
        shapes: true,
      }));
      return undefined;
    }
    return pb ?? undefined;
  }

  static async load(scenario?: string): Promise<PlanStore> {
    if (scenario) {
      const res = await fetch(`${BASE}data/scenarios/${encodeURIComponent(scenario)}/manifest.json`);
      if (!res.ok) throw new Error(`Scenario "${scenario}" isn't built (HTTP ${res.status}). Run "npm run scenario -- ${scenario}".`);
      const sm = (await res.json()) as ScenarioManifest;
      return new PlanStore({ schema: 1, generatedAt: sm.builtAt, feeds: sm.feeds }, sm);
    }
    const res = await fetch(`${BASE}data/manifest.json`);
    if (!res.ok) throw new Error(`No timetable data (HTTP ${res.status}). Run "npm run data" first.`);
    return new PlanStore((await res.json()) as FeedManifest);
  }

  /** Track network to draw and route on. */
  get tracksPath(): string {
    return this.scenario?.tracks ?? 'data/infra/tracks.geojson';
  }

  /** Instants covered by the available feeds: first service day start to end of last service day. */
  range(): [number, number] | undefined {
    const r = manifestRange(this.manifest);
    if (!r) return undefined;
    return [serviceDayStart(r.start), serviceDayStart(addDays(r.end, 1)) + 4 * 3600_000];
  }

  /** Prepared plan for a service date, or undefined while it loads (a change event fires when ready). */
  planFor(date: string): PreparedPlan | undefined {
    const feed = feedForDate(this.manifest, date);
    if (!feed) return undefined;
    const p = this.prepared.get(feed.version);
    if (p) return p;
    if (!this.loading.has(feed.version)) {
      const promise = fetch(`${BASE}${feed.path}`)
        .then((r) => {
          if (!r.ok) throw new Error(`Failed to load ${feed.path}: HTTP ${r.status}`);
          return r.json() as Promise<ServicePlan>;
        })
        .then((plan) => {
          const pp = preparePlan(plan, kinematics);
          this.prepared.set(feed.version, pp);
          this.loading.delete(feed.version);
          this.emit();
          return pp;
        });
      promise.catch((e) => {
        console.error(e);
        this.loading.delete(feed.version);
      });
      this.loading.set(feed.version, promise);
    }
    return undefined;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Vehicles at instant t (epoch ms): SkyTrain from track-level playback where movement files exist,
   * everything else (and SkyTrain as a fallback) from the schedule engine.
   */
  vehiclesAt(t: number, routes?: Set<string>): VehicleState[] {
    const today = localDate(t);
    const out: VehicleState[] = [];
    for (const date of [addDays(today, -1), today]) {
      const pp = this.planFor(date);
      if (!pp) continue;
      const sec = (t - serviceDayStart(date)) / 1000;
      if (sec < 0) continue;
      const pb = this.playbackFor(date, pp);
      if (pb) {
        out.push(...pb.vehiclesAt(sec, date, routes, this.correctionsFor(date, pb, pp)));
        const nonRail = new Set([...(routes ?? pp.routes.keys())].filter((k) => pp.routes.get(k)?.kind !== 'skytrain'));
        out.push(...scheduledVehicles(pp, { serviceDate: date, sec, routes: nonRail }, this.scheduledCorrectionsFor(date, pp)));
      } else out.push(...scheduledVehicles(pp, { serviceDate: date, sec, routes }, this.scheduledCorrectionsFor(date, pp)));
    }
    return out;
  }
}

/**
 * The service date shown in the UI for an instant: times before 03:00 belong to the previous
 * service day, matching how the timetable (and riders) think about late-night trips.
 */
export const SERVICE_DAY_ROLLOVER_H = 3;
export function displayServiceDate(t: number): string {
  return localDate(t - SERVICE_DAY_ROLLOVER_H * 3600_000);
}

const railServiceCache = new WeakMap<PreparedPlan, Set<string>>();
/** Service ids with SkyTrain trips (movement files are keyed by these only). */
function railServices(pp: PreparedPlan): Set<string> {
  let s = railServiceCache.get(pp);
  if (!s) {
    s = new Set(pp.plan.trips.filter((t) => pp.routes.get(pp.plan.patterns[t.pattern]!.route)?.kind === 'skytrain').map((t) => t.service));
    railServiceCache.set(pp, s);
  }
  return s;
}
