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
  BUS_TICKS_SOURCE,
  CORRIDORS_SOURCE,
  OVERVIEW_CORRIDORS_SOURCE,
  overviewCorridors,
  tickStops,
} from "./static.ts";

/** "Now" counts the hour around the shown time, refreshed in steps of this many seconds. */
const NOW_STEP_S = 300;

type Item = (readonly [number, number, number])[];

export class BusFrequencyLayer {
  readonly plan: ServicePlan;
  private readonly freq: BusFrequency;
  /** Per corridor source, its corridors' patterns. */
  private readonly corridorItems: [string, Item[]][];
  /** Tick feature ids (stop indices) and their patterns. */
  private readonly stopIds: number[];
  private readonly stopItems: Item[];
  /** Pattern → its route is drawn on its own (category "frequent"), not as part of corridors. */
  private readonly branded: boolean[];
  private key = "";

  constructor(plan: ServicePlan) {
    this.plan = plan;
    this.freq = new BusFrequency(plan);
    const brandedRoutes = new Set(
      plan.routes
        .filter((r) => r.kind === "bus" && r.category !== "regular")
        .map((r) => r.key),
    );
    this.branded = plan.patterns.map((p) => brandedRoutes.has(p.route));
    const items = (corridors: PlanCorridor[]) =>
      corridors.map((c) =>
        c.refs.map(
          ([p, dir, along]) => [p, this.freq.offsetAt(p, along), dir] as const,
        ),
      );
    this.corridorItems = [
      [CORRIDORS_SOURCE, items(plan.corridors ?? [])],
      [OVERVIEW_CORRIDORS_SOURCE, items(overviewCorridors(plan))],
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
  }

  /** Forget what was applied (after the sources were re-created or their data replaced). */
  invalidate(): void {
    this.key = "";
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
    for (const [source, items] of this.corridorItems)
      this.freq
        .count(items, date, window, t, (p) => shown(p) && !this.branded[p])
        .forEach((perHour, id) =>
          map.setFeatureState({ source, id }, { tier: frequencyTier(perHour) }),
        );
    const stops = this.freq.count(this.stopItems, date, window, t, shown);
    stops.forEach((perHour, i) =>
      map.setFeatureState(
        { source: BUS_TICKS_SOURCE, id: this.stopIds[i]! },
        { tier: frequencyTier(perHour) },
      ),
    );
  }
}
