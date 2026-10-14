// Browser side of SeaBus AIS (packages/transit-core/DESIGN.md#seabus-ais): a service date's fixes come from its day file
// (GET /regions/<id>/days/<YYYYMMDD>/seabus/ais, shared by every visitor), then from the live
// endpoint's trailing window while the clock is near now (acceptLive). Both are by batch time on the
// server, so a window that starts before what the day file reached continues it; one that doesn't
// (the tab slept) refetches the day file. Fixes become schedule corrections with the core matcher.
// When new fixes arrive, vessels glide from where they were drawn to their corrected positions
// (core/ais/glide.ts) instead of jumping; times the fixes already cover use every fix (hindsight),
// so replays never jump.

import {
  decodeFixes,
  serviceDateWindow,
  type AisDayResponse,
} from "@transitopia/transit-core/ais/fixes.ts";
import {
  sectionsOfKind,
  type LiveTransitResponse,
} from "@transitopia/transit-core/rt/live.ts";
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
  /** mmsi|ts of each fix, to merge overlapping day files and windows. */
  keys: Set<string>;
  /** Server time (epoch ms) through which every recorded batch is in `fixes`. */
  syncedTo: number;
  /** The day file says the date is over and all its fixes are in: nothing more will arrive. */
  complete: boolean;
  loading: boolean;
  /** When the day file was last requested (0: never). */
  fetchedAt: number;
  /** A live window didn't reach back to syncedTo: the day file must fill the gap. */
  gap: boolean;
  /** The latest live window received while the day file loaded, to continue it once it's in. */
  held?: { from: number; to: number } | undefined;
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
  /** URL prefix of the region on the RT service (…/regions/<id>/), or undefined for schedules only. */
  private readonly base: string | undefined;
  private readonly match: AisMatchConfig;
  private readonly glide: GlideConfig;
  /** Vessel names by MMSI. */
  private readonly names: Map<string, string>;
  /** Without live data, how often a date in progress refetches its day file (s). */
  private readonly refreshS: number;
  /** Whether the live endpoint is answering (then its windows keep dates current). */
  private readonly liveFresh: () => boolean;

  constructor(
    base: string | undefined,
    config: Pick<RegionConfig, "rt" | "seabus">,
    liveFresh: () => boolean,
  ) {
    this.base = base;
    this.match = config.seabus.ais.match;
    this.glide = config.seabus.ais.glide;
    this.names = new Map(
      config.seabus.ais.vessels.map((v) => [v.mmsi, v.name]),
    );
    this.refreshS = config.rt.clientPollMaxS;
    this.liveFresh = liveFresh;
    this.available = base !== undefined;
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
          keys: new Set(),
          syncedTo: 0,
          complete: false,
          loading: false,
          fetchedAt: 0,
          gap: false,
        }),
      );
      while (this.dates.size > MAX_DATES)
        this.dates.delete(this.dates.keys().next().value!);
    }
    if (
      !d.complete
      && !d.loading
      && (d.fetchedAt === 0
        || d.gap
        || (!this.liveFresh()
          && Date.now() - d.fetchedAt > this.refreshS * 1000))
    )
      void this.fetchDay(date, d);
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

  /** The SeaBus window of a live response: new fixes for the dates loaded, and how far they reach. */
  acceptLive(r: LiveTransitResponse): void {
    if (!this.available) return;
    const live = sectionsOfKind(r, "ais").find((x) => x.route === ROUTE);
    if (!live) return;
    this.error = live.error;
    if (live.status === "unavailable") return;
    const fixes = this.named(decodeFixes(live.data));
    for (const [date, d] of this.dates) {
      if (d.complete || d.fetchedAt === 0) continue;
      const [from, to] = serviceDateWindow(date);
      this.add(
        d,
        fixes.filter((f) => f.ts >= from && f.ts < to),
      );
      if (d.loading) d.held = { from: live.from, to: live.to };
      else if (live.from <= d.syncedTo)
        d.syncedTo = Math.max(d.syncedTo, live.to);
      else d.gap = true;
    }
  }

  private named(fixes: AisFix[]): AisFix[] {
    return fixes.map((f) => ({ ...f, name: this.names.get(f.mmsi) ?? f.name }));
  }

  /** Merge fixes into a date's, noting when new ones arrived (for the glide). */
  private add(d: DateFixes, fixes: AisFix[]): void {
    const fresh = fixes.filter((f) => !d.keys.has(`${f.mmsi}|${f.ts}`));
    if (!fresh.length) return;
    for (const f of fresh) d.keys.add(`${f.mmsi}|${f.ts}`);
    if (d.fixes.length) d.arrivedAt = Date.now();
    d.fixes = [...d.fixes, ...fresh].sort((a, b) => a.ts - b.ts);
    for (const fn of this.listeners) fn();
  }

  private async fetchDay(date: string, d: DateFixes): Promise<void> {
    d.loading = true;
    d.fetchedAt = Date.now();
    d.gap = false;
    try {
      // Revalidated with the ETag: an unchanged day file is a 304.
      const res = await fetch(`${this.base}days/${date}/seabus/ais`, {
        cache: "no-cache",
      });
      if (res.status === 404) {
        this.available = false;
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as AisDayResponse;
      this.error = body.error;
      this.add(d, this.named(decodeFixes(body.fixes)));
      d.syncedTo = Math.max(d.syncedTo, body.to);
      // A live window that arrived meanwhile continues the day file if it reaches back to it.
      if (d.held && d.held.from <= d.syncedTo)
        d.syncedTo = Math.max(d.syncedTo, d.held.to);
      else if (d.held) d.gap = true;
      d.complete = body.complete;
    } catch {
      this.error = "Real-time service unreachable";
    } finally {
      d.held = undefined;
      d.loading = false;
    }
  }
}
