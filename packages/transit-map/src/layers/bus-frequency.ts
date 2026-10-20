// Colours bus corridors and stop ticks by how often buses pass (packages/transit-map/README.md#bus-corridors):
// tiers from CorridorFrequency's worst waits, written as MapLibre feature state so changing the time or the window
// never re-tiles a source. Recomputed only when the date, window, hidden routes, focused route or
// (for "now") the five-minute bucket of the time change. While a route is focused (its card is open),
// the corridors it runs on show its own frequency and colour, and the rest are dimmed (`dim`).

import type { Map as MlMap } from "maplibre-gl";
import type { FrequencyWindow } from "@transitopia/transit-core/schedule/frequency.ts";
import {
  capShort,
  CorridorFrequency,
  shortCorridorNeighbours,
  type ComboFrequencies,
} from "@transitopia/transit-core/plan/corridor-frequency.ts";
import { bandIndex } from "@transitopia/shared/frequency.ts";
import type { ServicePlan } from "@transitopia/transit-core/plan/types.ts";
import type { ServiceDate } from "@transitopia/transit-core/time.ts";
import {
  brandedRoutes,
  BUS_TICKS_SOURCE,
  CORRIDORS_SOURCE,
  detailedCorridors,
  OVERVIEW_CORRIDORS_SOURCE,
  overviewCorridors,
  tickStops,
} from "./static.ts";

/** "Now" counts trips in the hour from the shown time, refreshed in steps of this many seconds. */
const NOW_STEP_S = 300;
/**
 * A route with its own colour is drawn in it only where it runs at least this share as often as on
 * its busiest stretch; elsewhere (limited service, e.g. the 99 east of Commercial–Broadway) its buses
 * count towards the frequency colour like any other (packages/transit-core/src/plan/coverage.ts).
 */
const LIMITED_SHARE = 0.25;

export class BusFrequencyLayer {
  readonly plan: ServicePlan;
  /** The plan's detailed corridors when it was made (they load later: a new layer is made then). */
  readonly corridors: ServicePlan["corridors"];
  private readonly combos: CorridorFrequency;
  /** Per source: its features' ids (corridor or stop index) and their combos. */
  private readonly sources: {
    source: string;
    ids: number[];
    combo: Int32Array;
    /** Short corridors and the corridors they join (none for stops). */
    short: [number, number[]][];
    stops: boolean;
  }[];
  /** Brand index (brandedRoutes order) per routeDir, or -1. */
  private readonly brandOf: number[];
  /** Per source, the corridors (or stops) last given a `brand`. */
  private readonly brandShown = new Map<string, Set<number>>();
  private key = "";
  /** Every shown route's frequencies, as last applied. */
  private rates: ComboFrequencies | undefined;
  /** Bumped whenever update applies new rates (so the engine knows to re-colour vehicles). */
  version = 0;

  constructor(plan: ServicePlan) {
    this.plan = plan;
    this.corridors = plan.corridors;
    this.combos = new CorridorFrequency(plan);
    const brands = brandedRoutes(plan).map((r) => r.key);
    this.brandOf = this.combos.routeDirs.map((rd) => brands.indexOf(rd.route));
    const corridors = (source: string, cs: typeof plan.corridors) => ({
      source,
      ids: (cs ?? []).map((_, i) => i),
      combo: this.combos.combosOfCorridors(cs ?? []),
      short: shortCorridorNeighbours(cs ?? []),
      stops: false,
    });
    const stopIds = tickStops(plan);
    this.sources = [
      corridors(CORRIDORS_SOURCE, detailedCorridors(plan)),
      corridors(OVERVIEW_CORRIDORS_SOURCE, overviewCorridors(plan)),
      {
        source: BUS_TICKS_SOURCE,
        ids: stopIds,
        combo: this.combos.combosOfStops(stopIds),
        short: [],
        stops: true,
      },
    ];
  }

  /**
   * Forget what was applied, after the sources were re-created or their data replaced: and clear
   * their feature state, which MapLibre keeps by feature id across new data, where an id may now be
   * another corridor (the detailed corridors replacing the overview's, which stand in for them
   * until they load, or another feed's). Removing it isn't enough: MapLibre applies a source's
   * state changes only while it's drawn, and changes still queued (the detailed corridors' while
   * zoomed out) outlive a removal followed by new state. So the next update also sets every
   * feature's `brand`, as for features that had one.
   */
  invalidate(map: MlMap): void {
    this.key = "";
    for (const s of this.sources) {
      this.brandShown.set(s.source, new Set(s.ids));
      if (map.getSource(s.source)) map.removeFeatureState({ source: s.source });
    }
  }

  update(
    map: MlMap,
    date: ServiceDate,
    seconds: number,
    window: FrequencyWindow,
    hidden: ReadonlySet<string>,
    focus: string | undefined,
  ): void {
    if (!map.getSource(CORRIDORS_SOURCE)) return;
    const step = window === "now" ? Math.floor(seconds / NOW_STEP_S) : 0;
    const key = `${date}|${window}|${step}|${[...hidden].join(",")}|${focus ?? ""}`;
    if (key === this.key) return;
    this.key = key;
    this.version++;
    const query =
      window === "now" ?
        { date, from: step * NOW_STEP_S, seconds: 3600 }
      : ("weekdays" as const);
    const all = this.combos.frequencies(query, (route) => !hidden.has(route));
    this.rates = all;
    const own =
      focus === undefined ? undefined : (
        this.combos.frequencies(query, (route) => route === focus)
      );
    // Frequency tiers count every route: where a route with its own colour is drawn in it, it
    // covers the tier line; where it isn't (limited service), its buses count like any other.
    for (const s of this.sources) {
      const onFocus = Array.from(
        s.combo,
        (c) => focus === undefined || this.serves(c, focus),
      );
      const ratesAt = (i: number) => (own && onFocus[i] ? own : all);
      const waits = capShort(
        Float32Array.from(s.combo, (c, i) => ratesAt(i).best[c]!),
        s.short,
      );
      s.ids.forEach((id, i) =>
        map.setFeatureState(
          { source: s.source, id },
          {
            tier: Number.isFinite(waits[i]) ? bandIndex(waits[i]!) : -1,
            dim: !onFocus[i],
          },
        ),
      );
      this.applyBrands(map, s, ratesAt);
    }
  }

  /**
   * The routes running along a corridor (a feature of CORRIDORS_SOURCE or OVERVIEW_CORRIDORS_SOURCE)
   * at the time and in the window last applied, busiest first: what a tap on it selects.
   */
  routesOn(source: string, id: number): string[] {
    const s = this.sources.find((x) => x.source === source && !x.stops);
    const c = s?.combo[id];
    if (c === undefined || !this.rates) return [];
    const rates = this.rates.trips[c]!;
    const best = new Map<string, number>();
    this.combos.combos[c]!.units.forEach((u, k) => {
      const route = this.combos.routeDirs[u.routeDir]!.route;
      if (rates[k]! > 0)
        best.set(route, Math.max(best.get(route) ?? 0, rates[k]!));
    });
    return [...best].sort((a, b) => b[1] - a[1]).map(([r]) => r);
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

  /**
   * On each corridor (or stop only such routes serve), the busiest route with its own colour
   * running then, where it runs at least LIMITED_SHARE as often as at its busiest.
   */
  private applyBrands(
    map: MlMap,
    s: BusFrequencyLayer["sources"][number],
    ratesAt: (i: number) => ComboFrequencies,
  ): void {
    // Per combo and frequencies: [brand, its trips] of each route with its own colour there (the
    // busier direction).
    const perCombo = new Map<
      ComboFrequencies,
      Map<number, Map<number, number>>
    >();
    const ownOf = (c: number, i: number) => {
      const rates = ratesAt(i);
      let cache = perCombo.get(rates);
      if (!cache) perCombo.set(rates, (cache = new Map()));
      let own = cache.get(c);
      if (own) return own;
      own = new Map();
      let others = false;
      this.combos.combos[c]!.units.forEach((u, k) => {
        const b = this.brandOf[u.routeDir]!;
        if (b < 0) others = true;
        else own!.set(b, Math.max(own!.get(b) ?? 0, rates.trips[c]![k]!));
      });
      if (s.stops && others) own.clear();
      cache.set(c, own);
      return own;
    };
    const perFeature = Array.from(s.combo, ownOf);
    const busiest = new Map<number, number>();
    for (const own of perFeature)
      for (const [b, n] of own)
        busiest.set(b, Math.max(busiest.get(b) ?? 0, n));
    const best = new Map<number, number>();
    perFeature.forEach((own, i) => {
      let top: [number, number] | undefined;
      for (const [b, n] of own)
        if (
          n > 0
          && n >= LIMITED_SHARE * busiest.get(b)!
          && n > (top?.[1] ?? 0)
        )
          top = [b, n];
      if (top) best.set(s.ids[i]!, top[0]);
    });
    for (const id of this.brandShown.get(s.source) ?? [])
      if (!best.has(id))
        map.setFeatureState({ source: s.source, id }, { brand: -1 });
    for (const [id, b] of best)
      map.setFeatureState({ source: s.source, id }, { brand: b });
    this.brandShown.set(s.source, new Set(best.keys()));
  }
}
