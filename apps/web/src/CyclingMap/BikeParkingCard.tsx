import React from "react";

import {
  CardRow,
  CardSection,
  InfoCard,
  shareLink,
  type CardAction,
} from "../components/InfoCard.tsx";
import type { MapParkingElement } from "../Map/MapData.ts";
import { BIKE_TILE } from "./BikeRouteCard.tsx";

/** OSM's bicycle_parking values, in words ("wide_stands" → "Wide stands"). */
function parkingType(t: string): string {
  const s = t.replace(/[_-]/g, " ");
  return s[0]!.toUpperCase() + s.slice(1);
}

const yesNo = (v: boolean | undefined) =>
  v === undefined ? "Unknown"
  : v ? "Yes"
  : "No";

/**
 * Bike parking (apps/web/README.md#feature-cards), with its details from the cycling tiles.
 * Ignores the map's time: OSM has no history.
 */
export const BikeParkingCard: React.FC<{
  feature: MapParkingElement;
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
    {
      id: "share",
      label: "Share link",
      icon: "share",
      onSelect: () =>
        shareLink(location.href, `${f.name ?? "Bike parking"} · Transitopia`),
    },
  ];
  const type = f.bicycle_parking && parkingType(f.bicycle_parking);
  const osm =
    f.osmWayId === undefined ? `node/${f.osmNodeId}` : `way/${f.osmWayId}`;
  return (
    <InfoCard
      tile={{ text: "P", ...BIKE_TILE }}
      eyebrow="Bike parking"
      title={f.name ?? "Bicycle parking"}
      subtitle={f.operator}
      chips={type ? [{ label: type }] : undefined}
      actions={actions}
      onClose={onClose}
      footer={
        <>
          <p>From OpenStreetMap.</p>
          <a
            href={`https://www.openstreetmap.org/${osm}`}
            target="_blank"
            rel="noreferrer"
            className="mt-1 inline-block font-bold text-(--card-link)">
            View or edit on OpenStreetMap
          </a>
        </>
      }>
      <CardSection title="Details">
        <CardRow
          label="Capacity"
          value={f.capacity ? `${f.capacity} bikes` : "Unknown"}
          muted={!f.capacity}
        />
        <CardRow label="Type" value={type ?? "Unknown"} muted={!type} />
        <CardRow
          label="Covered"
          value={yesNo(f.covered)}
          muted={f.covered === undefined}
        />
        <CardRow
          label="Indoors"
          value={yesNo(f.indoor)}
          muted={f.indoor === undefined}
        />
      </CardSection>
    </InfoCard>
  );
};
