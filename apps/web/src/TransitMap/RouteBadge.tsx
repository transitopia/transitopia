import React from "react";
import type { TransitEngine } from "@transitopia/transit-map/engine.ts";
import type { PlanRoute } from "@transitopia/transit-core/plan/types.ts";
import { bandOf } from "./frequency.ts";

/** A route's badge: buses by number, rail and ferries by initial (E, M, C, S, W). */
export function badge(r: PlanRoute): string {
  return r.mode === "bus" ? r.key : r.label[0]!.toUpperCase();
}

export interface RouteColors {
  bg: string;
  fg: string;
}

/**
 * The colours cards show a route in (apps/web/README.md#service-frequency): its own (`PlanRoute.brand`,
 * while the viewer has brand colours on), else the band of its weekday figure, as the map's "Day"
 * bus frequency colours it.
 */
export function routeColorsFor(
  engine: TransitEngine,
): (r: PlanRoute) => RouteColors {
  const brandColors = engine.getSnapshot().brandColors;
  return (r) => {
    const own = { bg: r.color, fg: r.textColor };
    if (r.brand && brandColors) return own;
    const wait = engine.dayWait(r.key);
    return wait === undefined ? own : { bg: bandOf(wait).color, fg: "#ffffff" };
  };
}

const BADGE_CLASS =
  "flex h-[22px] min-w-8 items-center justify-center rounded-[5px] px-[5px] text-xs font-extrabold";

/** The badge in the route's colours, leading departure rows and "View route" menu items. */
export const RouteBadge: React.FC<{
  route: PlanRoute;
  colors: RouteColors;
}> = ({ route, colors }) => (
  <span
    className={BADGE_CLASS}
    style={{ background: colors.bg, color: colors.fg }}>
    {badge(route)}
  </span>
);

/** A combined row shows at most this many badges, then "…" for the rest. */
const STACK_MAX = 3;

/**
 * A combined row's routes (apps/web/README.md#station-and-stop-cards), badges stacked in a column:
 * the first three, then "…" (the rest in its tooltip) when there are more.
 */
export const RouteBadgeStack: React.FC<{
  routes: PlanRoute[];
  colors: (r: PlanRoute) => RouteColors;
}> = ({ routes, colors }) => {
  const shown = routes.length > STACK_MAX ? routes.slice(0, STACK_MAX) : routes;
  const rest = routes.slice(shown.length);
  return (
    <span className="flex flex-none flex-col gap-[3px]">
      {shown.map((r) => (
        <RouteBadge key={r.key} route={r} colors={colors(r)} />
      ))}
      {rest.length ?
        <span
          className={`${BADGE_CLASS} bg-(--card-chip-bg) text-(--card-muted)`}
          title={`Also ${rest.map(badge).join(", ")}`}>
          …
        </span>
      : null}
    </span>
  );
};
