import React from "react";

import type {
  CyclingRoute,
  CyclingRoutes,
} from "@transitopia/cycling-core/published.ts";
import {
  CardRow,
  CardSection,
  InfoCard,
  shareLink,
  type CardAction,
  type CardChip,
} from "../components/InfoCard.tsx";
import type { MapCyclingElement } from "../Map/MapData.ts";

/** Bike cards use the cycling mode's green (OpenStreetMap features have no route colour). */
export const BIKE_TILE = { bg: "#5cc88d", fg: "#0b3d23" };

/** A bike route's name, or its ref. */
export const routeName = (r: CyclingRoute) => r.name ?? r.ref ?? "Bike route";

/** What kind of facility this is, from the tiles' attributes (packages/cycling-core/src/classify.ts). */
function kind(f: MapCyclingElement): string {
  if (f.class === "track")
    return f.shared_with_pedestrians ? "Shared path" : (
        "Protected bike lane or path"
      );
  if (f.shared_with_vehicles)
    return f.comfort >= 3 ?
        "Local street bikeway"
      : "Shared lane on a busy street";
  return "Painted bike lane";
}

/** A path's card title: its name, or what it is. */
export const pathTitle = (f: MapCyclingElement) => f.name ?? kind(f);

function chips(f: MapCyclingElement): CardChip[] {
  const out: CardChip[] = [];
  if (f.construction) out.push({ label: "Under construction", tone: "warn" });
  if (f.class === "track")
    out.push({ label: "Separated from traffic", tone: "good" });
  else if (f.shared_with_vehicles)
    out.push({
      label: "Shared with traffic",
      tone: f.comfort >= 3 ? "info" : "warn",
    });
  if (f.dooring_risk)
    out.push({ label: "Dooring risk (parked cars)", tone: "warn" });
  if (f.shared_with_pedestrians) out.push({ label: "Shared with pedestrians" });
  if (f.oneway === 1 || f.oneway === -1) out.push({ label: "One-way" });
  return out;
}

/** Its bike routes' chips, each opening its route's card (once the bike routes are read). */
function routeChips(
  f: MapCyclingElement,
  routes: CyclingRoutes | undefined,
  onRoute: (id: string) => void,
): CardChip[] {
  if (!f.routes || !routes) return [];
  return f.routes.split(",").flatMap((id) => {
    const r = routes[id];
    if (!r) return [];
    const name = routeName(r);
    return [
      {
        label: name,
        color: BIKE_TILE,
        onSelect: () => onRoute(id),
        action: `View bike route: ${name}`,
      },
    ];
  });
}

/** A bike lane or path (apps/web/README.md#feature-cards). Ignores the map's time: OSM has no history. */
export const BikeRouteCard: React.FC<{
  feature: MapCyclingElement;
  /** The bike routes, to name the ones it's part of. */
  routes: CyclingRoutes | undefined;
  onRoute: (id: string) => void;
  onCentre: () => void;
  onClose: () => void;
}> = ({ feature: f, routes, onRoute, onCentre, onClose }) => {
  const type = kind(f);
  const title = pathTitle(f);
  const actions: CardAction[] = [
    {
      id: "centre",
      label: "Centre on map",
      icon: "crosshair",
      onSelect: onCentre,
    },
    {
      id: "share",
      label: "Share link",
      icon: "share",
      onSelect: () => shareLink(location.href, `${title} · Transitopia`),
    },
  ];
  return (
    <InfoCard
      tile={{ icon: "bicycle", ...BIKE_TILE }}
      eyebrow="Bike route"
      title={title}
      subtitle={f.name ? type : undefined}
      chips={[...chips(f), ...routeChips(f, routes, onRoute)]}
      actions={actions}
      onClose={onClose}
      footer={<p>From OpenStreetMap, via Transitopia's cycling layer.</p>}>
      <CardSection title="Details">
        <CardRow
          label="Surface"
          value={
            f.surface ?
              f.surface[0]!.toUpperCase()
              + f.surface.slice(1).replace(/_/g, " ")
            : "Unknown"
          }
          muted={!f.surface}
        />
        {f.opening_date ?
          <CardRow label="Opens" value={f.opening_date} />
        : null}
        {f.website && /^https?:\/\//i.test(f.website) ?
          <CardRow
            label="More information"
            value={
              <a
                href={f.website}
                target="_blank"
                rel="noreferrer"
                className="text-(--card-link) underline">
                Website
              </a>
            }
          />
        : null}
      </CardSection>
    </InfoCard>
  );
};
