// The site's route groups, its layers panel's switches (apps/web/README.md#header-and-layers, issue
// #211): from the timetable, not an operator's labels, so the same rule holds in every region.

import { isFrequent } from "@transitopia/shared/frequency.ts";
import { spacingTier } from "@transitopia/shared/stop-spacing.ts";
import type { PlanRoute } from "./types.ts";

/**
 * Rapid transit: rail and ferries (dedicated right of way). Frequent: a bus whose weekday figure
 * (`PlanRoute.weekdayWait`) is in a frequent band (Good or OK). Fast: a bus whose stops are far
 * enough apart (`PlanRoute.stops`: Limited stops or Express). Regular: every other bus. A bus can
 * be both frequent and fast.
 */
export type RouteGroup = "rapid" | "frequent" | "fast" | "regular";

export const ROUTE_GROUPS: readonly RouteGroup[] = [
  "rapid",
  "frequent",
  "fast",
  "regular",
];

/**
 * The groups a route is in. `weekdayWait` is its weekday figure (minutes), passed in because a
 * host may work it out for a plan published without it.
 */
export function routeGroups(
  r: PlanRoute,
  weekdayWait: number | undefined = r.weekdayWait,
): RouteGroup[] {
  if (r.mode !== "bus") return ["rapid"];
  const out: RouteGroup[] = [];
  if (weekdayWait !== undefined && isFrequent(weekdayWait))
    out.push("frequent");
  if (r.stops && spacingTier(r.stops.spacing).fast) out.push("fast");
  return out.length ? out : ["regular"];
}
