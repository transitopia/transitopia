// Collects GTFS-RT service changes for our bus routes per service date (src/core/rt/changes.ts) and
// keeps them in data/rt-history/changes/YYYYMMDD.json, since TransLink's feeds drop a trip's
// cancellation once it has run and an alert once it's over.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { emptyDayChanges, type RtDayChanges, type RtRouteAlert } from '@transitopia/transit-core/rt/changes.ts';
import { localDate } from '@transitopia/transit-core/time.ts';

/** Days kept in memory; older ones are read from disk when asked for. */
const MAX_DAYS_CACHED = 4;

export interface TripChangeInput {
  tripId: string;
  /** Service date, YYYYMMDD. */
  date: string;
  cancelled: boolean;
  skippedStopIds: string[];
}

export class ServiceChanges {
  private days = new Map<string, RtDayChanges>();
  private writing: Promise<void> = Promise.resolve();

  constructor(
    readonly dir: string,
    private record: boolean,
  ) {}

  private path(date: string): string {
    return join(this.dir, `${date}.json`);
  }

  /** A service date's changes (empty when nothing was recorded). */
  async get(date: string): Promise<RtDayChanges> {
    let d = this.days.get(date);
    if (d) return d;
    try {
      d = JSON.parse(await readFile(this.path(date), 'utf8')) as RtDayChanges;
    } catch {
      d = emptyDayChanges(date);
    }
    // Loaded meanwhile by another call: keep that one (it may have updates).
    const again = this.days.get(date);
    if (again) return again;
    this.days.set(date, d);
    while (this.days.size > MAX_DAYS_CACHED) this.days.delete(this.days.keys().next().value!);
    return d;
  }

  /** Trips cancelled or skipping stops in one trip-updates poll (already filtered to our routes). */
  async updateTrips(trips: TripChangeInput[], now = Date.now()): Promise<void> {
    const touched = new Set<string>();
    for (const c of trips) {
      const d = await this.get(c.date);
      if (c.cancelled) {
        const seen = d.cancelled[c.tripId];
        d.cancelled[c.tripId] = seen ? [seen[0], now] : [now, now];
        touched.add(c.date);
      } else if (c.skippedStopIds.length) {
        const old = d.skipped[c.tripId] ?? [];
        const all = [...new Set([...old, ...c.skippedStopIds])];
        if (all.length !== old.length) {
          d.skipped[c.tripId] = all;
          touched.add(c.date);
        }
      }
    }
    for (const date of touched) this.save(date);
  }

  /** Alerts for our bus routes in one alerts poll, recorded under today's (local) date. */
  async updateAlerts(alerts: Omit<RtRouteAlert, 'seen'>[], now = Date.now()): Promise<void> {
    if (!alerts.length) return;
    const date = localDate(now);
    const d = await this.get(date);
    for (const a of alerts) {
      const i = d.alerts.findIndex((x) => x.id === a.id);
      const old = i >= 0 ? d.alerts[i]! : undefined;
      // The latest wording wins (TransLink edits alerts: "UPDATE: ...").
      const next: RtRouteAlert = { ...a, seen: [old?.seen[0] ?? now, now] };
      if (old) d.alerts[i] = next;
      else d.alerts.push(next);
    }
    this.save(date);
  }

  private save(date: string): void {
    if (!this.record) return;
    const d = this.days.get(date);
    if (!d) return;
    this.writing = this.writing
      .then(async () => {
        await mkdir(this.dir, { recursive: true });
        const tmp = `${this.path(date)}.tmp`;
        await writeFile(tmp, JSON.stringify(d));
        await rename(tmp, this.path(date));
      })
      .catch((e) => console.error('[rt] service changes write error:', e));
  }

  /** Resolves when queued writes are done (tests). */
  flushed(): Promise<void> {
    return this.writing;
  }
}
