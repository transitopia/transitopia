// Browser side of SeaBus AIS (PLAN.md §4.12): fetches a service date's fixes from /rt/ais/fixes
// (polling for new ones while the date is in progress) and turns them into schedule corrections
// with the core matcher. The RT service holds the only upstream connection.

import rtConfig from '../../data/config/rt.json';
import seabusConfig from '../../data/config/seabus.json';
import { decodeFixes, serviceDateWindow, type AisFixesResponse } from '../core/ais/fixes.ts';
import { aisCorrections, type AisDay, type AisFix, type AisMatchConfig } from '../core/ais/match.ts';
import type { PreparedPlan, ScheduleCorrections } from '../core/schedule/engine.ts';

const BASE = import.meta.env.BASE_URL;
const ROUTE = 'seabus';
const MATCH = Object.fromEntries(Object.entries(seabusConfig.ais.match).filter(([k]) => !k.startsWith('$'))) as unknown as AisMatchConfig;
const NAMES = new Map(seabusConfig.ais.vessels.map((v) => [v.mmsi, v.name]));
const MAX_DATES = 4;

interface DateFixes {
  fixes: AisFix[];
  cursor: number;
  epoch: number;
  /** Fetched through the end of the date's window: nothing more will arrive. */
  complete: boolean;
  loading: boolean;
  nextPollAt: number;
  memo?: { pp: PreparedPlan; n: number; day: AisDay };
}

export class AisClient {
  private dates = new Map<string, DateFixes>();
  private listeners = new Set<() => void>();
  available = true;
  /** Why live AIS data is unavailable, for display. */
  error: string | undefined;

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** SeaBus corrections for a service date from its AIS fixes (fetching them as needed). */
  correctionsFor(date: string, pp: PreparedPlan): ScheduleCorrections | undefined {
    return this.dayFor(date, pp)?.corrections;
  }

  /** The berth pair in use on a service date, per its AIS fixes; undefined without any. */
  pairFor(date: string, pp: PreparedPlan): string | undefined {
    return this.dayFor(date, pp)?.pair;
  }

  private dayFor(date: string, pp: PreparedPlan): AisDay | undefined {
    if (!this.available) return undefined;
    let d = this.dates.get(date);
    if (!d) {
      this.dates.set(date, (d = { fixes: [], cursor: 0, epoch: 0, complete: false, loading: false, nextPollAt: 0 }));
      while (this.dates.size > MAX_DATES) this.dates.delete(this.dates.keys().next().value!);
    }
    if (!d.complete && !d.loading && Date.now() >= d.nextPollAt) void this.fetch(date, d);
    if (!d.fixes.length) return undefined;
    if (d.memo?.pp !== pp || d.memo.n !== d.fixes.length) d.memo = { pp, n: d.fixes.length, day: aisCorrections(pp, date, d.fixes, ROUTE, MATCH) };
    return d.memo.day;
  }

  private async fetch(date: string, d: DateFixes): Promise<void> {
    d.loading = true;
    try {
      const res = await fetch(`${BASE}rt/ais/fixes?date=${date}${d.cursor ? `&after=${d.cursor}` : ''}`, { cache: 'no-cache' });
      if (res.status === 404) {
        this.available = false;
        return;
      }
      const body = (await res.json()) as AisFixesResponse;
      this.error = body.error;
      const fresh = decodeFixes(body.fixes).map((f) => ({ ...f, name: NAMES.get(f.mmsi) ?? f.name }));
      // A restarted service numbers fixes afresh: start over.
      if (body.epoch !== d.epoch) {
        d.fixes = [];
        d.epoch = body.epoch;
        if (d.cursor) {
          d.cursor = 0;
          d.loading = false;
          return this.fetch(date, d);
        }
      }
      if (fresh.length) {
        d.fixes = [...d.fixes, ...fresh].sort((a, b) => a.ts - b.ts);
        for (const fn of this.listeners) fn();
      }
      d.cursor = body.cursor;
      d.complete = Date.now() > serviceDateWindow(date)[1] + 60_000;
    } catch {
      this.error = 'Real-time service unreachable';
    } finally {
      d.loading = false;
      d.nextPollAt = Date.now() + rtConfig.clientPollS * 1000;
    }
  }
}
