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

/** Example vehicle colour for the key (Expo Line blue). */
const KEY_COLOR = "#1d3fa6";

/**
 * A vehicle as the map draws it (packages/transit-map/src/layers/vehicles.ts): solid with a darker
 * edge for observed positions, translucent with a white edge (and a hairline, so the white shows on a
 * light panel) for estimated ones.
 */
export const ProvenanceSwatch: React.FC<{ estimated: boolean }> = ({
  estimated,
}) => (
  <svg
    aria-hidden="true"
    width="30"
    height="14"
    viewBox="0 0 30 14"
    className="mr-1 inline-block flex-none align-[-2px]">
    {estimated ?
      <>
        <polygon
          points="2,2 22,2 28,7 22,12 2,12"
          fill={KEY_COLOR}
          fillOpacity={0.62}
          stroke="#ffffff"
          strokeWidth={2}
        />
        <polygon
          points="0.5,0.5 22.6,0.5 29.5,7 22.6,13.5 0.5,13.5"
          fill="none"
          className="stroke-gray-300 dark:stroke-gray-600"
          strokeWidth={0.75}
        />
      </>
    : <polygon
        points="2,2 22,2 28,7 22,12 2,12"
        fill={KEY_COLOR}
        className="stroke-[#12307f] dark:stroke-[#0b1220]"
        strokeWidth={1}
      />
    }
  </svg>
);
