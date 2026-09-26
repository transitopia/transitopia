// Loads the feed manifest and service plans on demand, and answers "which vehicles exist at instant t"
// by querying the service days that can have trips running then (today, and yesterday's after-midnight
// trips), each against the feed that covers that date.

import kinematicsConfig from '../../data/config/kinematics.json';
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

  private constructor(readonly manifest: FeedManifest) {}

  static async load(): Promise<PlanStore> {
    const res = await fetch(`${BASE}data/manifest.json`);
    if (!res.ok) throw new Error(`No timetable data (HTTP ${res.status}). Run "npm run data" first.`);
    return new PlanStore((await res.json()) as FeedManifest);
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
          for (const fn of this.listeners) fn();
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

  /** Scheduled vehicles at instant t (epoch ms). */
  vehiclesAt(t: number, routes?: Set<string>): VehicleState[] {
    const today = localDate(t);
    const out: VehicleState[] = [];
    for (const date of [addDays(today, -1), today]) {
      const pp = this.planFor(date);
      if (!pp) continue;
      const sec = (t - serviceDayStart(date)) / 1000;
      if (sec < 0) continue;
      out.push(...scheduledVehicles(pp, { serviceDate: date, sec, routes }));
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
