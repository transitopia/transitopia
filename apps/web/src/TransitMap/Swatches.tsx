import type React from "react";
import type { PlanRoute } from "@transitopia/transit-core/plan/types.ts";

/** A route's line colour, thinner for buses. */
export const RouteSwatch: React.FC<{ route: PlanRoute }> = ({ route }) => (
  <span
    aria-hidden="true"
    className={`inline-block w-6 flex-none rounded ${route.kind === "bus" ? "h-[3px] opacity-80" : "h-[5px]"}`}
    style={{ background: route.color }}
  />
);

/** Vehicle fill: hollow-ish for estimated positions, solid for observed ones. */
export const ProvenanceSwatch: React.FC<{ estimated: boolean }> = ({
  estimated,
}) => (
  <span
    aria-hidden="true"
    className={`mr-1 inline-block h-2 w-3 rounded-sm border-[1.5px] border-current align-[-1px] ${estimated ? "bg-current/30" : "bg-current"}`}
  />
);
