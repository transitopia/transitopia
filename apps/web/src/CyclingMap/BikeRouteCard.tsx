import React from "react";

import {
  CardRow,
  CardSection,
  InfoCard,
  type CardAction,
  type CardChip,
} from "../components/InfoCard.tsx";
import type { MapCyclingElement } from "../Map/MapData.ts";

/** Bike cards use the cycling mode's green (OpenStreetMap features have no route colour). */
export const BIKE_TILE = { bg: "#5cc88d", fg: "#0b3d23" };

/** What kind of facility this is, from the tiles' attributes (map-layers Cycling.java). */
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

/** A bike lane or path (apps/web/README.md#feature-cards). Ignores the map's time: OSM has no history. */
export const BikeRouteCard: React.FC<{
  feature: MapCyclingElement;
  onCentre: () => void;
  onClose: () => void;
}> = ({ feature: f, onCentre, onClose }) => {
  const actions: CardAction[] = [
    {
      id: "centre",
      label: "Centre on map",
      icon: "crosshair",
      onSelect: onCentre,
    },
  ];
  const type = kind(f);
  return (
    <InfoCard
      tile={{ icon: "bicycle", ...BIKE_TILE }}
      eyebrow="Bike route"
      title={f.name ?? type}
      subtitle={f.name ? type : undefined}
      chips={chips(f)}
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
