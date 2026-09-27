// Browser side of real-time buses (PLAN.md §4.5–4.6). Near "now" it polls /rt/live; at other times
// it loads recorded hours from /rt/history. It also tracks recorder coverage, which decides per
// instant whether buses are shown from RT data (observed/interpolated) or schedule (estimated).

import rtConfig from '../../data/config/rt.json';
import { coverageContains, decodeSnapshot, type RtCoverageResponse, type RtLiveResponse, type RtSnapshot } from '../core/rt/types.ts';
import { RtTimeline } from '../core/rt/timeline.ts';
import { Predictor, type PredictionConfig, type RtProfileFile } from '../core/rt/profile.ts';
import type { PreparedPlan, VehicleState } from '../core/schedule/engine.ts';
import { toWallTime } from '../core/time.ts';
import { kinematics } from './plans.ts';

const BASE = import.meta.env.BASE_URL;
/** Live mode applies when the clock is within this of wall-clock time. */
const LIVE_WINDOW_MS = 10 * 60_000;
/** How much live history to keep in memory for interpolation. */
const LIVE_BUFFER_MS = 20 * 60_000;
const MAX_HOURS_CACHED = 8;
const PREDICTION = rtConfig.prediction as unknown as PredictionConfig;

export type RtMode = 'live' | 'recorded' | 'estimated' | 'unavailable';

interface HourChunk {
  status: 'loading' | 'ready' | 'missing';
  snapshots: RtSnapshot[];
}

export class RtClient {
  private live: RtSnapshot[] = [];
  private liveError: string | undefined;
  private liveTimer: ReturnType<typeof setTimeout> | undefined;
  private hours = new Map<string, HourChunk>();
  private coverage: [number, number][] = [];
  private coverageRange: [number, number] | undefined;
  private coverageFetchedAt = 0;
  private timeline: RtTimeline | undefined;
  private timelineKey = '';
  /** Per feed version: the predictor, once its travel-time profile has loaded (or turned out missing). */
  private predictors = new Map<string, Predictor | 'loading'>();
  private listeners = new Set<() => void>();
  available = true;

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  /** Called every frame with the clock time; schedules any fetches needed. */
  update(t: number): void {
    const nearNow = Math.abs(t - Date.now()) < LIVE_WINDOW_MS;
    if (nearNow) this.ensureLivePolling();
    else this.stopLivePolling();
    if (!nearNow || t < Date.now() - rtConfig.maxInterpolateS * 1000) this.ensureHours(t);
  }

  /** Coverage intervals within [from, to], fetching if the cached range doesn't cover it. */
  coverageFor(from: number, to: number): [number, number][] {
    const now = Date.now();
    const includesNow = from <= now && now <= to;
    const stale = includesNow && now - this.coverageFetchedAt > 60_000;
    if (!this.coverageRange || from < this.coverageRange[0] || to > this.coverageRange[1] || stale) {
      if (now - this.coverageFetchedAt > 5_000) void this.fetchCoverage(from, to);
    }
    const out = this.coverage.filter(([a, b]) => b >= from && a <= to);
    // The live buffer extends coverage to the present even before the index is refreshed.
    const span = this.liveSpan();
    if (span) out.push(span);
    return out;
  }

  /** RT vehicles at t, or undefined when RT data doesn't cover t (use schedule estimates). */
  vehiclesAt(t: number, pp: PreparedPlan | undefined, routes?: Set<string>): { mode: RtMode; vehicles?: VehicleState[] } {
    if (!this.available) return { mode: 'unavailable' };
    const liveSpan = this.liveSpan();
    const inLive = liveSpan !== undefined && t >= liveSpan[0] && t <= liveSpan[1] + rtConfig.staleAfterS * 1000;
    const covered = inLive || coverageContains(this.coverage, t, rtConfig.coverageGapS * 1000);
    if (!covered) return { mode: 'estimated' };

    const snapshots = inLive ? this.live : this.snapshotsAround(t);
    if (!snapshots) return { mode: 'estimated' };
    const predictor = pp ? this.predictorFor(pp) : undefined;
    const key = `${inLive ? 'live' : 'rec'}:${snapshots.length}:${snapshots[0]?.fetchedAt}:${snapshots.at(-1)?.fetchedAt}:${pp?.plan.feedVersion}:${predictor ? 'p' : ''}`;
    if (key !== this.timelineKey) {
      this.timelineKey = key;
      this.timeline = new RtTimeline(snapshots, pp, kinematics, {
        maxInterpolateS: rtConfig.maxInterpolateS,
        maxExtrapolateS: rtConfig.maxExtrapolateS,
        source: inLive ? 'GTFS-RT live' : 'GTFS-RT recorded',
        ...(predictor ? { prediction: { cfg: PREDICTION, predictor } } : {}),
      });
    }
    return { mode: inLive ? 'live' : 'recorded', vehicles: this.timeline!.vehiclesAt(t, routes) };
  }

  /** Profile-based predictor for a feed; undefined while its profile loads. */
  predictorFor(pp: PreparedPlan): Predictor | undefined {
    const version = pp.plan.feedVersion;
    const p = this.predictors.get(version);
    if (p === 'loading') return undefined;
    if (p) return p;
    this.predictors.set(version, 'loading');
    // Scenario plans ("<version>~<name>") share the base feed's profile.
    const base = version.split('~')[0];
    fetch(`${BASE}data/feeds/${base}/rt-profile.json`)
      .then((r) => (r.ok ? (r.json() as Promise<RtProfileFile>) : undefined))
      .catch(() => undefined)
      .then((profile) => {
        // Without a profile, the timetable still gives better predictions than a fixed speed.
        this.predictors.set(version, new Predictor(pp, PREDICTION, profile));
        this.emit();
      });
    return undefined;
  }

  liveStatus(): string | undefined {
    return this.liveError;
  }

  // --- live ---

  private liveSpan(): [number, number] | undefined {
    const last = this.live.at(-1);
    if (!last || Date.now() - last.fetchedAt > rtConfig.staleAfterS * 1000) return undefined;
    return [this.live[0]!.fetchedAt, last.fetchedAt];
  }

  private ensureLivePolling(): void {
    if (this.liveTimer !== undefined) return;
    const poll = async () => {
      try {
        const res = await fetch(`${BASE}rt/live`, { cache: 'no-cache' });
        if (res.status === 404) {
          // No RT service (e.g. a static build without the proxy).
          this.available = false;
          this.liveError = 'Real-time service not available';
          this.emit();
          return;
        }
        const body = (await res.json()) as RtLiveResponse;
        this.liveError = body.error;
        if (body.snapshot && !body.stale) {
          const s: RtSnapshot = { ...body.snapshot, receivedAt: Math.max(Date.now(), body.snapshot.fetchedAt) };
          if (!this.live.length || s.fetchedAt > this.live.at(-1)!.fetchedAt) {
            this.live.push(s);
            const cutoff = Date.now() - LIVE_BUFFER_MS;
            while (this.live.length > 2 && this.live[0]!.fetchedAt < cutoff) this.live.shift();
            this.emit();
          }
        }
      } catch {
        this.liveError = 'Real-time service unreachable';
      }
      if (this.liveTimer !== undefined) this.liveTimer = setTimeout(poll, rtConfig.clientPollS * 1000);
    };
    this.liveTimer = setTimeout(poll, 0);
  }

  private stopLivePolling(): void {
    if (this.liveTimer === undefined) return;
    clearTimeout(this.liveTimer);
    this.liveTimer = undefined;
  }

  // --- recorded history ---

  private hourId(t: number): { id: string; date: string; hour: string } {
    const w = toWallTime(t);
    const date = `${w.year}-${String(w.month).padStart(2, '0')}-${String(w.day).padStart(2, '0')}`;
    const hour = String(w.hour).padStart(2, '0');
    return { id: `${date}T${hour}`, date, hour };
  }

  /** Load the hour containing t, plus the neighbouring hour when t is near a boundary. */
  private ensureHours(t: number): void {
    if (!coverageContains(this.coverage, t, 15 * 60_000)) return;
    const margin = rtConfig.maxInterpolateS * 1000;
    const ids = new Map<string, { date: string; hour: string }>();
    for (const x of [t - margin, t, t + margin]) {
      const h = this.hourId(x);
      ids.set(h.id, h);
    }
    for (const [id, { date, hour }] of ids) {
      if (this.hours.has(id)) continue;
      const chunk: HourChunk = { status: 'loading', snapshots: [] };
      this.hours.set(id, chunk);
      void this.loadHour(date, hour, chunk);
    }
    // Evict least-recently-added hours beyond the cache size.
    while (this.hours.size > MAX_HOURS_CACHED) this.hours.delete(this.hours.keys().next().value!);
  }

  private async loadHour(date: string, hour: string, chunk: HourChunk): Promise<void> {
    try {
      const res = await fetch(`${BASE}rt/history?date=${date}&hour=${hour}`);
      if (!res.ok) {
        chunk.status = 'missing';
        return;
      }
      const text = await res.text();
      chunk.snapshots = text
        .split('\n')
        .filter(Boolean)
        .map(decodeSnapshot);
      chunk.status = 'ready';
      this.emit();
    } catch {
      chunk.status = 'missing';
    }
  }

  /** Snapshots from loaded hours around t, or undefined while they load. */
  private snapshotsAround(t: number): RtSnapshot[] | undefined {
    const margin = rtConfig.maxInterpolateS * 1000;
    const out: RtSnapshot[] = [];
    const seen = new Set<string>();
    for (const x of [t - margin, t, t + margin]) {
      const { id } = this.hourId(x);
      if (seen.has(id)) continue;
      seen.add(id);
      const chunk = this.hours.get(id);
      if (!chunk || chunk.status === 'loading') return undefined;
      out.push(...chunk.snapshots);
    }
    return out.sort((a, b) => a.fetchedAt - b.fetchedAt);
  }

  private async fetchCoverage(from: number, to: number): Promise<void> {
    this.coverageFetchedAt = Date.now();
    // Fetch a generous window so scrubbing around the day doesn't refetch.
    const lo = from - 86_400_000;
    const hi = to + 86_400_000;
    try {
      const res = await fetch(`${BASE}rt/coverage?from=${Math.round(lo)}&to=${Math.round(hi)}`);
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
