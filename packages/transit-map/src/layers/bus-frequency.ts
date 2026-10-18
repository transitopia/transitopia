// Colours bus corridors and stop ticks by how often buses pass (packages/transit-map/README.md#bus-corridors):
// tiers from CorridorFrequency, written as MapLibre feature state so changing the time or the window
// never re-tiles a source. Recomputed only when the date, window, hidden routes or (for "now") the
// five-minute bucket of the time change.

import type { Map as MlMap } from "maplibre-gl";
import {
  BusFrequency,
  type FrequencyWindow,
} from "@transitopia/transit-core/plan/bus-frequency.ts";
import {
  capShort,
  CorridorFrequency,
  shortCorridorNeighbours,
  type ComboRates,
} from "@transitopia/transit-core/plan/corridor-frequency.ts";
import { bandIndexPerHour as frequencyTier } from "@transitopia/shared/frequency.ts";
import type { ServicePlan } from "@transitopia/transit-core/plan/types.ts";
import type { ServiceDate } from "@transitopia/transit-core/time.ts";
import {
  brandedRoutes,
  BUS_TICKS_SOURCE,
  CORRIDORS_SOURCE,
  OVERVIEW_CORRIDORS_SOURCE,
  overviewCorridors,
  tickStops,
} from "./static.ts";

/** "Now" counts trips starting in the hour from the shown time, refreshed in steps of this many seconds. */
const NOW_STEP_S = 300;
/**
 * A route with its own colour is drawn in it only where it runs at least this share as often as on
 * its busiest stretch; elsewhere (limited service, e.g. the 99 east of Commercial–Broadway) its buses
 * count towards the frequency colour like any other (packages/transit-core/src/plan/coverage.ts).
 */
const LIMITED_SHARE = 0.25;

export class BusFrequencyLayer {
  readonly plan: ServicePlan;
  private readonly freq: BusFrequency;
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

  constructor(plan: ServicePlan) {
    this.plan = plan;
    this.freq = new BusFrequency(plan);
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
      corridors(CORRIDORS_SOURCE, plan.corridors),
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

  /** Forget what was applied (after the sources were re-created or their data replaced). */
  invalidate(): void {
    this.key = "";
    this.brandShown.clear();
  }

  update(
    map: MlMap,
    date: ServiceDate,
    seconds: number,
    window: FrequencyWindow,
    hidden: ReadonlySet<string>,
  ): void {
    if (!map.getSource(CORRIDORS_SOURCE)) return;
    const step = window === "now" ? Math.floor(seconds / NOW_STEP_S) : 0;
    const key = `${date}|${window}|${step}|${[...hidden].join(",")}`;
    if (key === this.key) return;
    this.key = key;
    const rates = this.combos.rates(
      this.freq.perHour(date, window, step * NOW_STEP_S),
      (route) => !hidden.has(route),
    );
    // Frequency tiers count every route: where a route with its own colour is drawn in it, it
    // covers the tier line; where it isn't (limited service), its buses count like any other.
    for (const s of this.sources) {
      const perHour = capShort(
        Float32Array.from(s.combo, (c) => rates.best[c]!),
        s.short,
      );
      s.ids.forEach((id, i) =>
        map.setFeatureState(
          { source: s.source, id },
          { tier: frequencyTier(perHour[i]!) },
        ),
      );
      this.applyBrands(map, s, rates);
    }
  }

  /**
   * On each corridor (or stop only such routes serve), the busiest route with its own colour
   * running then, where it runs at least LIMITED_SHARE as often as at its busiest.
   */
  private applyBrands(
    map: MlMap,
    s: BusFrequencyLayer["sources"][number],
    rates: ComboRates,
  ): void {
    // Per combo: [brand, its rate] of each route with its own colour there (the busier direction).
    const perCombo = new Map<number, Map<number, number>>();
    const ownOf = (c: number) => {
      let own = perCombo.get(c);
      if (own) return own;
      own = new Map();
      let others = false;
      this.combos.combos[c]!.units.forEach((u, k) => {
        const b = this.brandOf[u.routeDir]!;
        if (b < 0) others = true;
        else own!.set(b, Math.max(own!.get(b) ?? 0, rates.units[c]![k]!));
      });
      if (s.stops && others) own.clear();
      perCombo.set(c, own);
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
