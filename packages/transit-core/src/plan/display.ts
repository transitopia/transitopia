// How a feed's identifiers are shown to riders (docs/DESIGN.md#regions-and-feeds). Each agency
// shapes its trip ids and feed versions differently, so a feed says how to shorten them
// (feeds/<feed>/feed.json → display: a regex whose first group is the short form), and the plan
// carries that (ServicePlan.agency, feedLabel, tripIdPattern). Internally the full ids are kept.

import { baseName, isBay } from "./exchanges.ts";
import { STOP_NO_PICKUP, type PlanPattern, type ServicePlan } from "./types.ts";

/** The first group of `pattern` in `id`, or the whole id when there's no pattern or no match. */
export function shortId(pattern: string | undefined, id: string): string {
  if (!pattern) return id;
  return new RegExp(pattern).exec(id)?.[1] || id;
}

/** "TransLink timetable (26SEP_20260925)", "BC Transit timetable (202610140)". */
export function timetableLabel(
  plan: Pick<ServicePlan, "agency" | "feedLabel" | "feedVersion">,
): string {
  const version = plan.feedLabel ?? plan.feedVersion;
  return plan.agency ?
      `${plan.agency} timetable (${version})`
    : `timetable ${version}`;
}

/**
 * The stop where riders can first board a pattern's trips (index into its stops): trips may start
 * at a layover nobody boards at ("Newton Exchange @ Layover").
 */
export function firstBoarding(pattern: PlanPattern): number {
  const i = pattern.stops.findIndex(
    (_, k) => !((pattern.access?.[k] ?? 0) & STOP_NO_PICKUP),
  );
  return i < 0 ? 0 : i;
}

/**
 * A stop as a rider would name it: its station, its exchange, or the stop without a direction
 * prefix ("Westbound Lougheed Hwy @ Boundary Loop" → "Lougheed Hwy @ Boundary Loop").
 */
export function placeName(
  plan: Pick<ServicePlan, "stops" | "stations">,
  stopIndex: number,
): string {
  const stop = plan.stops[stopIndex]!;
  const station =
    stop.parent && plan.stations.find((s) => s.id === stop.parent);
  if (station) return station.name;
  if (isBay(stop.name)) return baseName(stop.name);
  return stop.name.replace(/^(North|South|East|West)bound\s+/i, "");
}
