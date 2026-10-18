import React from "react";
import type {
  TransitEngine,
  TransitSnapshot,
} from "@transitopia/transit-map/engine.ts";
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
 * The colours cards show a route in (apps/web/README.md#service-frequency): its own, except a regular
 * bus route the map draws, which has none and takes its day frequency band, as the map's "Day" bus
 * frequency colours it. Catalogue routes (not drawn) keep the plan's grey.
 */
export function routeColorsFor(
  engine: TransitEngine,
  snap: TransitSnapshot,
): (r: PlanRoute) => RouteColors {
  return (r) => {
    const own = { bg: r.color, fg: r.textColor };
    if (r.mode !== "bus" || r.category !== "regular") return own;
    if (!snap.routes.some((x) => x.key === r.key)) return own;
    const minutes = engine.dayMinutes(r.key);
    return minutes === undefined ? own : (
        { bg: bandOf(minutes).color, fg: "#ffffff" }
      );
  };
}

/** The badge in the route's colours, leading departure rows and "View route" menu items. */
export const RouteBadge: React.FC<{
  route: PlanRoute;
  colors: RouteColors;
  ring?: boolean;
}> = ({ route, colors, ring }) => (
  <span
    className={`flex h-[22px] min-w-8 items-center justify-center rounded-[5px] px-[5px] text-xs font-extrabold ${ring ? "-ml-1.5 shadow-[0_0_0_2px_var(--card-combined-bg)] first:ml-0" : ""}`}
    style={{ background: colors.bg, color: colors.fg }}>
    {badge(route)}
  </span>
);
