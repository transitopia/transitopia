// Colours bus corridors and stop ticks by how often buses pass (packages/transit-map/README.md#bus-corridors):
// tiers from CorridorFrequency's worst waits, written as MapLibre feature state so changing the time or the window
// never re-tiles a source. Recomputed only when the date, window, hidden routes, focused route or
// (for "now") the five-minute bucket of the time change. While a route is focused (its card is open),
// the corridors it runs on show its own frequency and colour, and the rest are dimmed (`dim`); a
// combined route likewise, on the corridors of its stretch (packages/transit-map/README.md#route-focus).
// Corridors whose routes don't run in the window are `idle`: drawn dotted grey, not left out.

import type { Map as MlMap } from "maplibre-gl";
import type {
  FrequencyWindow,
  Starts,
} from "@transitopia/transit-core/schedule/frequency.ts";
import {
  CorridorFrequency,
  corridorStyle,
  type ComboFrequencies,
} from "@transitopia/transit-core/plan/corridor-frequency.ts";
import {
  brandedRoutes,
  PLAN_TILE_LAYERS,
} from "@transitopia/transit-core/plan/tiles.ts";
import { bandIndex } from "@transitopia/shared/frequency.ts";
import type { ServicePlan } from "@transitopia/transit-core/plan/types.ts";
import type { ServiceDate } from "@transitopia/transit-core/time.ts";
import { BUS_TICKS_SOURCE, LINES_SOURCE, tickStops } from "./static.ts";

/** "Now" counts trips in the hour from the shown time, refreshed in steps of this many seconds. */
const NOW_STEP_S = 300;

/**
 * Where "Now"'s hour starts for a shown time (service seconds): the time, to the step before it
 * (NOW_STEP_S), so the colours change only every few minutes. Hosts label the window with it.
 */
export function nowWindowStart(seconds: number): number {
  return Math.floor(seconds / NOW_STEP_S) * NOW_STEP_S;
}
/**
 * What the map focuses on: a route (its card is open), or a combined route: its routes, its
 * departures from its start (`sources`: its stretch is drawn in their frequency, as its card shows
 * it), and the corridors (per set, by id) and stops (plan indices) along its stretch. Without its
 * corridors (their refs still loading, or none published), those carrying all its routes stand in.
 */
export type Focus =
  | { route: string }
  | {
      /** Tells one combined route from another. */
      key: string;
      routes: ReadonlySet<string>;
      sources: readonly Starts[];
      corridors:
        | { detailed: ReadonlySet<number>; overview: ReadonlySet<number> }
        | undefined;
      stops: ReadonlySet<number>;
    };

/** Where a set of features' state goes: a tile layer of the plan's tiles, or the stop ticks' source. */
interface Target {
  source: string;
  sourceLayer?: string | undefined;
}

export class BusFrequencyLayer {
  readonly plan: ServicePlan;
  private readonly combos: CorridorFrequency;
  /** Per target: its features' ids (corridor or stop index) and their combos. */
  private readonly targets: (Target & {
    set: "detailed" | "overview" | "stops";
    ids: number[];
    combo: Int32Array;
    /** Short corridors and the corridors they join (none for stops). */
    short: [number, number[]][];
    stops: boolean;
  })[];
  /** Brand index (brandedRoutes order) per routeDir, or -1. */
  private readonly brandOf: number[];
  /** Per target (by sourceLayer or source), the corridors (or stops) last given a `brand`. */
  private readonly brandShown = new Map<string, Set<number>>();
  private key = "";
  /** Every shown route's frequencies, as last applied. */
  private rates: ComboFrequencies | undefined;
  /** Bumped whenever update applies new rates (so the engine knows to re-colour vehicles). */
  version = 0;

  /** For a plan with corridors (`plan.corridorInfo`). */
  constructor(plan: ServicePlan) {
    this.plan = plan;
    this.combos = new CorridorFrequency(plan);
    const brands = brandedRoutes(plan).map((r) => r.key);
    this.brandOf = this.combos.routeDirs.map((rd) => brands.indexOf(rd.route));
    const info = plan.corridorInfo!;
    const corridors = (
      sourceLayer: string,
      set: (typeof info)["detailed"],
      name: "detailed" | "overview",
    ) => ({
      set: name,
      source: LINES_SOURCE,
      sourceLayer,
      ids: set.combo.map((_, i) => i),
      combo: Int32Array.from(set.combo),
      short: set.short,
      stops: false,
    });
    const stopIds = tickStops(plan);
    this.targets = [
      corridors(PLAN_TILE_LAYERS.corridors, info.detailed, "detailed"),
      corridors(PLAN_TILE_LAYERS.overviewCorridors, info.overview, "overview"),
      {
        set: "stops",
        source: BUS_TICKS_SOURCE,
        ids: stopIds,
        combo: this.combos.combosOfStops(stopIds),
        short: [],
        stops: true,
      },
    ];
  }

  /**
   * Forget what was applied, after the sources were re-created: and clear their feature state,
   * which MapLibre keeps by feature id across new data. Removing it isn't enough: MapLibre applies a
   * source's state changes only while it's drawn, and changes still queued (the detailed corridors'
   * while zoomed out) outlive a removal followed by new state. So the next update also sets every
   * feature's `brand`, as for features that had one.
   */
  invalidate(map: MlMap): void {
    this.key = "";
    for (const t of this.targets) {
      this.brandShown.set(keyOf(t), new Set(t.ids));
      if (map.getSource(t.source))
        map.removeFeatureState(
          t.sourceLayer ?
            { source: t.source, sourceLayer: t.sourceLayer }
          : { source: t.source },
        );
    }
  }

  update(
    map: MlMap,
    date: ServiceDate,
    seconds: number,
    window: FrequencyWindow,
    hidden: ReadonlySet<string>,
    focus: Focus | undefined,
  ): void {
    if (!map.getSource(LINES_SOURCE)) return;
    const step = window === "now" ? nowWindowStart(seconds) : 0;
    const focusKey =
      !focus ? ""
      : "route" in focus ? focus.route
      : `${focus.key}|${focus.corridors ? 1 : 0}|${focus.sources.map((x) => x.offset).join()}`;
    const key = `${date}|${window}|${step}|${[...hidden].join(",")}|${focusKey}`;
    if (key === this.key) return;
    this.key = key;
    this.version++;
    const query =
      window === "now" ?
        { date, from: step, seconds: 3600 }
      : ("weekdays" as const);
    const all = this.combos.frequencies(query, (route) => !hidden.has(route));
    this.rates = all;
    const focused: (route: string) => boolean =
      !focus ? () => true
      : "route" in focus ? (route) => route === focus.route
      : (route) => focus.routes.has(route);
    const own = focus && this.combos.frequencies(query, focused);
    // A combined route's stretch is one frequency, its buses' merged departures from its start.
    const segmentWait =
      focus && "sources" in focus ?
        this.combos.waitOf(query, focus.sources)
      : undefined;
    // Frequency tiers count every route: where a route with its own colour is drawn in it, it
    // covers the tier line; where it isn't (limited service), its buses count like any other.
    // Without service in the window, a corridor carrying a route that isn't hidden is `idle`
    // (drawn dotted grey), so a route mentioned in the UI is never missing from the map.
    const shownOn = new Map<number, boolean>();
    const carriesShown = (c: number) => {
      let shown = shownOn.get(c);
      if (shown === undefined) {
        shown = this.combos.combos[c]!.units.some(
          (u) => !hidden.has(this.combos.routeDirs[u.routeDir]!.route),
        );
        shownOn.set(c, shown);
      }
      return shown;
    };
    for (const t of this.targets) {
      const onFocus = Array.from(t.combo, (c, i) => {
        if (!focus) return true;
        if ("route" in focus) return this.serves(c, focus.route);
        const id = t.ids[i]!;
        if (t.set === "stops") return focus.stops.has(id);
        if (focus.corridors) return focus.corridors[t.set].has(id);
        return [...focus.routes].every((r) => this.serves(c, r));
      });
      const ratesAt = (i: number) => (own && onFocus[i] ? own : all);
      const { waits, brands } = corridorStyle(
        this.combos,
        t.combo,
        t.short,
        this.brandOf,
        ratesAt,
        t.stops,
      );
      t.ids.forEach((id, i) => {
        const wait =
          segmentWait !== undefined && onFocus[i] ? segmentWait : waits[i]!;
        map.setFeatureState(
          { ...target(t), id },
          {
            tier: Number.isFinite(wait) ? bandIndex(wait) : -1,
            idle: !Number.isFinite(wait) && carriesShown(t.combo[i]!),
            dim: !onFocus[i],
          },
        );
      });
      const shown = new Map([...brands].map(([i, b]) => [t.ids[i]!, b]));
      for (const id of this.brandShown.get(keyOf(t)) ?? [])
        if (!shown.has(id))
          map.setFeatureState({ ...target(t), id }, { brand: -1 });
      for (const [id, b] of shown)
        map.setFeatureState({ ...target(t), id }, { brand: b });
      this.brandShown.set(keyOf(t), new Set(shown.keys()));
    }
  }

  /**
   * The routes running along a corridor (a feature of the tile layer `sourceLayer`) at the time and
   * in the window last applied, busiest first: what a tap on it selects. Where none runs then (an
   * idle corridor), every route along it.
   */
  routesOn(sourceLayer: string, id: number): string[] {
    const t = this.targets.find((x) => x.sourceLayer === sourceLayer);
    const c = t?.combo[id];
    if (c === undefined || !this.rates) return [];
    const rates = this.rates.trips[c]!;
    const best = new Map<string, number>();
    this.combos.combos[c]!.units.forEach((u, k) => {
      const route = this.combos.routeDirs[u.routeDir]!.route;
      best.set(route, Math.max(best.get(route) ?? 0, rates[k]!));
    });
    const running = [...best].filter(([, n]) => n > 0);
    return (running.length ? running : [...best])
      .sort((a, b) => b[1] - a[1])
      .map(([r]) => r);
  }

  /**
   * A route's worst wait (minutes) in its better direction, in the window last applied: the
   * frequency its corridors show while it's focused (wherever it runs its whole service), and its
   * vehicles' colour. Infinity when it doesn't run then; undefined for a route not shown.
   */
  routeWait(route: string): number | undefined {
    return this.rates?.routeWaits.get(route);
  }

  /** Whether a combo's buses include the route's. */
  private serves(combo: number, route: string): boolean {
    return this.combos.combos[combo]!.units.some(
      (u) => this.combos.routeDirs[u.routeDir]!.route === route,
    );
  }
}

const keyOf = (t: Target) => t.sourceLayer ?? t.source;
const target = (t: Target): Target =>
  t.sourceLayer ?
    { source: t.source, sourceLayer: t.sourceLayer }
  : { source: t.source };
