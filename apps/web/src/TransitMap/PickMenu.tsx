import React from "react";
import type {
  PickChoice,
  TransitEngine,
  TransitSnapshot,
} from "@transitopia/transit-map/engine.ts";

import { Icon } from "../components/Icon.tsx";
import { MenuList, type MenuItem } from "../components/Menu.tsx";
import { vehicleLabel } from "./FollowPill.tsx";
import { measureOverlays } from "./overlayPadding.ts";
import { RouteBadge, routeColorsFor } from "./RouteBadge.tsx";
import { cleanStopName, MODE, STATUS } from "./VehicleCard.tsx";

const PLACE_NOTE = {
  station: "Station",
  exchange: "Bus exchange",
  stop: "Bus stop",
  route: "Route",
} as const;

/**
 * A tap near several things on the map (apps/web/README.md#tap-menu): a menu at the tap of what it
 * might have meant, vehicles first. Choosing one opens its card; a press elsewhere, Escape or moving
 * the map closes it.
 */
export const PickMenu: React.FC<{
  engine: TransitEngine;
  snap: TransitSnapshot;
}> = ({ engine, snap }) => {
  const pick = snap.pick;
  if (!pick) return null;
  const colors = routeColorsFor(engine);
  // Within the part of the map the header, cards and time bar leave clear.
  const map = document.getElementById("map");
  const box = map?.getBoundingClientRect();
  const pad = map && measureOverlays(map);
  const bounds =
    box && pad ?
      {
        left: box.left + pad.left,
        top: box.top + pad.top,
        right: box.right - pad.right,
        bottom: box.bottom - pad.bottom,
      }
    : undefined;
  const item = (c: PickChoice, i: number): MenuItem => {
    const onSelect = () => engine.choose(c);
    if (c.kind === "vehicle")
      return {
        id: `v${i}`,
        label: c.route ? vehicleLabel(c.vehicle, c.route) : c.vehicle.headsign,
        // Where it is, as on its card, so two buses on one route can be told apart.
        note: [STATUS[c.vehicle.status], cleanStopName(c.vehicle.stopName)]
          .filter(Boolean)
          .join(" "),
        // The vehicle card's tile: a bus, train or ferry in the route's colours.
        ...(c.route ?
          {
            lead: (
              <span
                className="flex h-[26px] w-[26px] items-center justify-center rounded-md"
                style={{
                  background: colors(c.route).bg,
                  color: colors(c.route).fg,
                }}>
                <Icon icon={MODE[c.route.mode].icon} size={16} />
              </span>
            ),
          }
        : { icon: "bus-front-fill" as const }),
        onSelect,
      };
    const { kind } = c.place;
    return {
      id: `p${i}`,
      label: kind === "station" ? c.name.replace(/\s+Station$/i, "") : c.name,
      note: c.code ? `Stop #${c.code}` : PLACE_NOTE[kind],
      ...(c.route ?
        { lead: <RouteBadge route={c.route} colors={colors(c.route)} /> }
      : {
          icon:
            kind === "station" ? ("station" as const) : ("bus-stop" as const),
        }),
      onSelect,
    };
  };
  return (
    <MenuList
      // A new tap is a new menu (its position and first focus).
      key={`${pick.x},${pick.y}`}
      label="What's here"
      items={pick.choices.map(item)}
      anchor={{ left: pick.x, right: pick.x, top: pick.y, bottom: pick.y }}
      align="left"
      bounds={bounds}
      onClose={() => engine.dismissPick()}
    />
  );
};
