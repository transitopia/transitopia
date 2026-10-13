import React from "react";

import { useOsmFeature } from "../OSMData/osm-data-loader.ts";
import { bikeParkingSchema } from "../OSMData/osm-cycling.ts";
import { OsmFeatureType } from "../OSMData/osm-types.ts";
import {
  CardRow,
  CardSection,
  InfoCard,
  type CardAction,
} from "../components/InfoCard.tsx";
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
 * Bike parking (apps/web/README.md#feature-cards): details loaded on demand from the OSM API.
 * Ignores the map's time: OSM has no history.
 */
export const BikeParkingCard: React.FC<{
  featureType: typeof OsmFeatureType.Node | typeof OsmFeatureType.Way;
  osmId: number;
  onCentre: () => void;
  onClose: () => void;
}> = ({ featureType, osmId, onCentre, onClose }) => {
  const { data, error } = useOsmFeature(featureType, osmId, bikeParkingSchema);
  React.useEffect(() => {
    if (error) console.warn("OpenStreetMap loading error:", error);
  }, [error]);
  const actions: CardAction[] = [
    {
      id: "centre",
      label: "Centre on map",
      icon: "crosshair",
      onSelect: onCentre,
    },
  ];
  const type = data?.bicycleParkingType && parkingType(data.bicycleParkingType);
  return (
    <InfoCard
      tile={{ text: "P", ...BIKE_TILE }}
      eyebrow="Bike parking"
      title={data?.name ?? "Bicycle parking"}
      subtitle={data?.operator}
      chips={type ? [{ label: type }] : undefined}
      actions={actions}
      onClose={onClose}
      footer={
        <>
          <p>From OpenStreetMap.</p>
          <a
            href={`https://www.openstreetmap.org/${featureType}/${osmId}`}
            target="_blank"
            rel="noreferrer"
            className="mt-1 inline-block font-bold text-(--card-link)">
            View or edit on OpenStreetMap
          </a>
        </>
      }>
      <CardSection title="Details">
        {data ?
          <>
            <CardRow
              label="Capacity"
              value={data.capacity ? `${data.capacity} bikes` : "Unknown"}
              muted={!data.capacity}
            />
            <CardRow label="Type" value={type ?? "Unknown"} muted={!type} />
            <CardRow
              label="Covered"
              value={yesNo(data.covered)}
              muted={data.covered === undefined}
            />
            <CardRow
              label="Indoors"
              value={yesNo(data.indoor)}
              muted={data.indoor === undefined}
            />
          </>
        : error ?
          <CardRow label="Couldn't load the details from OpenStreetMap." />
        : <CardRow label="Loading…" />}
      </CardSection>
    </InfoCard>
  );
};
