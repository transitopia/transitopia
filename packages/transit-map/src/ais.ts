// Browser side of SeaBus AIS (packages/transit-core/DESIGN.md#seabus-ais): fetches a service date's fixes from /rt/ais/fixes
// (polling for new ones while the date is in progress) and turns them into schedule corrections
// with the core matcher. The RT service holds the only upstream connection. When new fixes arrive,
// vessels glide from where they were drawn to their corrected positions (core/ais/glide.ts) instead
// of jumping; times the fixes already cover use every fix (hindsight), so replays never jump.

import {
  decodeFixes,
  serviceDateWindow,
  type AisFixesResponse,
} from "@transitopia/transit-core/ais/fixes.ts";
import {
  aisCorrections,
  type AisDay,
  type AisFix,
  type AisMatchConfig,
} from "@transitopia/transit-core/ais/match.ts";
import {
  glideCorrections,
  type Glide,
  type GlideConfig,
} from "@transitopia/transit-core/ais/glide.ts";
import type {
  PreparedPlan,
  ScheduleCorrections,
} from "@transitopia/transit-core/schedule/engine.ts";
import { serviceDayStart } from "@transitopia/transit-core/time.ts";
import type { RegionConfig } from "./config.ts";

const ROUTE = "seabus";
const MAX_DATES = 4;

interface DateFixes {
  fixes: AisFix[];
  cursor: number;
  epoch: number;
  /** Fetched through the end of the date's window: nothing more will arrive. */
  complete: boolean;
  loading: boolean;
  nextPollAt: number;
  /** Epoch ms when the latest new fixes arrived, until folded into a glide. */
  arrivedAt?: number | undefined;
  /** Corrections from all fixes, and a glide from what was shown to them (service-day seconds). */
  memo?: {
    pp: PreparedPlan;
    n: number;
    day: AisDay;
    glide?: Glide & { from: number };
  };
}

export class AisClient {
  private dates = new Map<string, DateFixes>();
  private listeners = new Set<() => void>();
  available: boolean;
  /** Why live AIS data is unavailable, for display. */
  error: string | undefined;
  /** URL prefix of the RT service, or undefined for schedules only. */
  private readonly api: string | undefined;
  private readonly match: AisMatchConfig;
  private readonly glide: GlideConfig;
  /** Vessel names by MMSI. */
  private readonly names: Map<string, string>;
  /** How often to poll for new fixes while a date is in progress (s). */
  private readonly pollS: number;

  constructor(
    api: string | undefined,
    config: Pick<RegionConfig, "rt" | "seabus">,
  ) {
    this.api = api;
    this.match = config.seabus.ais.match;
    this.glide = config.seabus.ais.glide;
    this.names = new Map(
      config.seabus.ais.vessels.map((v) => [v.mmsi, v.name]),
    );
    this.pollS = config.rt.clientPollS;
    this.available = api !== undefined;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** SeaBus corrections for a service date at display time t (epoch ms), fetching fixes as needed. */
  correctionsFor(
    date: string,
    pp: PreparedPlan,
    t: number,
  ): ScheduleCorrections | undefined {
    const day = this.dayFor(date, pp);
    if (!day) return undefined;
    const glide = this.dates.get(date)?.memo?.glide;
    const sec = (t - serviceDayStart(date)) / 1000;
    return glide && sec >= glide.from && sec <= glide.until ?
        glide.corrections
      : day.corrections;
  }

  /** The berth pair in use on a service date, per its AIS fixes; undefined without any. */
  pairFor(date: string, pp: PreparedPlan): string | undefined {
    return this.dayFor(date, pp)?.pair;
  }

  private dayFor(date: string, pp: PreparedPlan): AisDay | undefined {
    if (!this.available) return undefined;
    let d = this.dates.get(date);
    if (!d) {
      this.dates.set(
        date,
        (d = {
          fixes: [],
          cursor: 0,
          epoch: 0,
          complete: false,
          loading: false,
          nextPollAt: 0,
        }),
      );
      while (this.dates.size > MAX_DATES)
        this.dates.delete(this.dates.keys().next().value!);
    }
    if (!d.complete && !d.loading && Date.now() >= d.nextPollAt)
      void this.fetch(date, d);
    if (!d.fixes.length) return undefined;
    if (d.memo?.pp !== pp || d.memo.n !== d.fixes.length) {
      const prev = d.memo?.pp === pp ? d.memo : undefined;
      const day = aisCorrections(pp, date, d.fixes, ROUTE, this.match);
      let glide: (Glide & { from: number }) | undefined;
      if (prev && d.arrivedAt !== undefined) {
        // Glide from what was on screen when the fixes arrived (mid-glide, if one was running).
        const k = (d.arrivedAt - serviceDayStart(date)) / 1000;
        const shown =
          prev.glide && k >= prev.glide.from && k <= prev.glide.until ?
            prev.glide.corrections
          : prev.day.corrections;
        const g = glideCorrections(
          pp,
          date,
          ROUTE,
          shown,
          day.corrections,
          k,
          this.glide,
        );
        if (g.until > k) glide = { ...g, from: k };
      }
      d.arrivedAt = undefined;
      d.memo = { pp, n: d.fixes.length, day, ...(glide ? { glide } : {}) };
    }
    return d.memo.day;
  }

  private async fetch(date: string, d: DateFixes): Promise<void> {
    d.loading = true;
    try {
      const res = await fetch(
        `${this.api}rt/ais/fixes?date=${date}${d.cursor ? `&after=${d.cursor}` : ""}`,
        { cache: "no-cache" },
      );
      if (res.status === 404) {
        this.available = false;
        return;
      }
      const body = (await res.json()) as AisFixesResponse;
      this.error = body.error;
      const fresh = decodeFixes(body.fixes).map((f) => ({
        ...f,
        name: this.names.get(f.mmsi) ?? f.name,
      }));
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
        if (d.fixes.length) d.arrivedAt = Date.now();
        d.fixes = [...d.fixes, ...fresh].sort((a, b) => a.ts - b.ts);
        for (const fn of this.listeners) fn();
      }
      d.cursor = body.cursor;
      d.complete = Date.now() > serviceDateWindow(date)[1] + 60_000;
    } catch {
      this.error = "Real-time service unreachable";
    } finally {
      d.loading = false;
      d.nextPollAt = Date.now() + this.pollS * 1000;
    }
  }
}
