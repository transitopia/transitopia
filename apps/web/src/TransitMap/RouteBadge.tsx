import React from "react";
import type { PlanRoute } from "@transitopia/transit-core/plan/types.ts";

/** A route's badge: buses by number, rail and ferries by initial (E, M, C, S, W). */
export function badge(r: PlanRoute): string {
  return r.mode === "bus" ? r.key : r.label[0]!.toUpperCase();
}

/** The badge in the route's colours, leading departure rows and "View route" menu items. */
export const RouteBadge: React.FC<{ route: PlanRoute; ring?: boolean }> = ({
  route,
  ring,
}) => (
  <span
    className={`flex h-[22px] min-w-8 items-center justify-center rounded-[5px] px-[5px] text-xs font-extrabold ${ring ? "-ml-1.5 shadow-[0_0_0_2px_var(--card-combined-bg)] first:ml-0" : ""}`}
    style={{ background: route.color, color: route.textColor }}>
    {badge(route)}
  </span>
);
