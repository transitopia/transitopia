// Colours bus corridors and stop ticks by how often buses pass (packages/transit-map/README.md#bus-corridors):
// tiers from BusFrequency, written as MapLibre feature state so changing the time or the window
// never re-tiles a source. Recomputed only when the date, window, hidden routes or (for "now") the
// five-minute bucket of the time change.

import type { Map as MlMap } from "maplibre-gl";
import {
  BusFrequency,
  frequencyTier,
  type FrequencyWindow,
} from "@transitopia/transit-core/plan/bus-frequency.ts";
import type {
  PlanCorridor,
  ServicePlan,
} from "@transitopia/transit-core/plan/types.ts";
import type { ServiceDate } from "@transitopia/transit-core/time.ts";
import {
  brandedRoutes,
  BUS_TICKS_SOURCE,
  CORRIDORS_SOURCE,
  OVERVIEW_CORRIDORS_SOURCE,
  overviewCorridors,
  tickStops,
} from "./static.ts";

/** "Now" counts the hour around the shown time, refreshed in steps of this many seconds. */
const NOW_STEP_S = 300;
/**
 * A route with its own colour is drawn in it only where it runs at least this share as often as on
 * its busiest stretch; elsewhere (limited service, e.g. the 99 east of Commercial–Broadway) its buses
 * count towards the frequency colour like any other (packages/transit-core/src/plan/coverage.ts).
 */
const LIMITED_SHARE = 0.25;

type Item = (readonly [number, number, number])[];

export class BusFrequencyLayer {
  readonly plan: ServicePlan;
  private readonly freq: BusFrequency;
  /** Per corridor source, its corridors' patterns. */
  private readonly corridorItems: [string, Item[]][];
  /** Tick feature ids (stop indices) and their patterns. */
  private readonly stopIds: number[];
  private readonly stopItems: Item[];
  /** Pattern → its route has its own colour (category "frequent"), drawn over the frequency tiers. */
  private readonly branded: boolean[];
  /** Per corridor source, per route with its own colour (brandedRoutes order): [corridor id, its patterns there]. */
  private readonly brandItems: [string, [number, Item][][]][];
  /** Per source, the corridors (or stops) last given a `brand`. */
  private readonly brandShown = new Map<string, Set<number>>();
  /** Per route with its own colour: [tick id, its patterns at that stop], for stops only such routes serve. */
  private readonly stopBrandItems: [number, Item][][];
  private key = "";

  constructor(plan: ServicePlan) {
    this.plan = plan;
    this.freq = new BusFrequency(plan);
    const brands = brandedRoutes(plan).map((r) => r.key);
    this.branded = plan.patterns.map((p) => brands.includes(p.route));
    const items = (corridors: PlanCorridor[]) =>
      corridors.map((c) =>
        c.refs.map(
          ([p, dir, along]) => [p, this.freq.offsetAt(p, along), dir] as const,
        ),
      );
    const regular = items(plan.corridors ?? []);
    const overview = items(overviewCorridors(plan));
    this.corridorItems = [
      [CORRIDORS_SOURCE, regular],
      [OVERVIEW_CORRIDORS_SOURCE, overview],
    ];
    const byBrand = (all: Item[]) =>
      brands.map((key) =>
        all.flatMap((refs, id): [number, Item][] => {
          const own = refs.filter(([p]) => plan.patterns[p]!.route === key);
          return own.length ? [[id, own]] : [];
        }),
      );
    this.brandItems = [
      [CORRIDORS_SOURCE, byBrand(regular)],
      [OVERVIEW_CORRIDORS_SOURCE, byBrand(overview)],
    ];
    const byStop = new Map<number, Item>();
    for (const s of tickStops(plan)) byStop.set(s, []);
    plan.patterns.forEach((p) =>
      p.stops.forEach((s, i) =>
        byStop.get(s)?.push([p.id, this.freq.stopOffset(p.id, i), 0] as const),
      ),
    );
    this.stopIds = [...byStop.keys()];
    this.stopItems = [...byStop.values()];
    this.stopBrandItems = brands.map((key) =>
      this.stopIds.flatMap((id, i): [number, Item][] => {
        const refs = this.stopItems[i]!;
        if (!refs.every(([p]) => this.branded[p])) return [];
        const own = refs.filter(([p]) => plan.patterns[p]!.route === key);
        return own.length ? [[id, own]] : [];
      }),
    );
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
    const t = step * NOW_STEP_S + NOW_STEP_S / 2;
    const shown = (p: number) => !hidden.has(this.plan.patterns[p]!.route);
    // Frequency tiers count every route: where a route with its own colour is drawn in it, it
    // covers the tier line; where it isn't (limited service), its buses count like any other.
    for (const [source, items] of this.corridorItems)
      this.freq
        .count(items, date, window, t, shown)
        .forEach((perHour, id) =>
          map.setFeatureState({ source, id }, { tier: frequencyTier(perHour) }),
        );
    const brandOf = (source: string, perRoute: [number, Item][][]) => {
      // On each corridor (or stop), the busiest route with its own colour running then, where it
      // runs at least LIMITED_SHARE as often as at its busiest.
      const best = new Map<number, [number, number]>();
      perRoute.forEach((list, b) => {
        if (!list.length) return;
        const counts = this.freq.count(
          list.map(([, refs]) => refs),
          date,
          window,
          t,
          shown,
        );
        const floor = LIMITED_SHARE * Math.max(0, ...counts);
        list.forEach(([id], k) => {
          const n = counts[k]!;
          if (n > 0 && n >= floor && n > (best.get(id)?.[1] ?? 0))
            best.set(id, [b, n]);
        });
      });
      for (const id of this.brandShown.get(source) ?? [])
        if (!best.has(id)) map.setFeatureState({ source, id }, { brand: -1 });
      for (const [id, [b]] of best)
        map.setFeatureState({ source, id }, { brand: b });
      this.brandShown.set(source, new Set(best.keys()));
    };
    for (const [source, perRoute] of this.brandItems) brandOf(source, perRoute);
    brandOf(BUS_TICKS_SOURCE, this.stopBrandItems);
    const stops = this.freq.count(this.stopItems, date, window, t, shown);
    stops.forEach((perHour, i) =>
      map.setFeatureState(
        { source: BUS_TICKS_SOURCE, id: this.stopIds[i]! },
        { tier: frequencyTier(perHour) },
      ),
    );
  }
}
