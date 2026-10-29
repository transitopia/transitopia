import React from "react";

import type { CyclingRoute } from "@transitopia/cycling-core/published.ts";
import {
  CardRow,
  CardSection,
  InfoCard,
  shareLink,
  type CardAction,
} from "../components/InfoCard.tsx";
import { BIKE_TILE, routeName } from "./BikeRouteCard.tsx";

/** OSM's route networks, in words. */
const NETWORKS: Record<string, string> = {
  lcn: "Local bike route",
  rcn: "Regional bike route",
  ncn: "National bike route",
  icn: "International bike route",
};

/**
 * A bike route, an OSM route relation (apps/web/README.md#feature-cards), from the published bike
 * routes; its paths are highlighted on the map from CYCLING_DETAIL_ZOOM.
 */
export const CyclingRouteCard: React.FC<{
  id: string;
  route: CyclingRoute;
  /** Fit the map to the whole route; none when it has no ways in the area. */
  onShowAll: (() => void) | undefined;
  back?: { label: string; onBack: () => void } | undefined;
  onClose: () => void;
}> = ({ id, route: r, onShowAll, back, onClose }) => {
  const title = routeName(r);
  const actions: CardAction[] = [
    ...(onShowAll ?
      [
        {
          id: "show-all",
          label: "Show whole route",
          icon: "crosshair",
          onSelect: onShowAll,
        } as const,
      ]
    : []),
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
      eyebrow={(r.network && NETWORKS[r.network]) ?? "Bike route"}
      title={title}
      subtitle={r.name && r.ref ? r.ref : undefined}
      actions={actions}
      back={back}
      onClose={onClose}
      footer={
        <>
          <p>From OpenStreetMap.</p>
          <a
            href={`https://www.openstreetmap.org/relation/${id}`}
            target="_blank"
            rel="noreferrer"
            className="mt-1 inline-block font-bold text-(--card-link)">
            View or edit on OpenStreetMap
          </a>
        </>
      }>
      <CardSection title="Details">
        <CardRow
          label="Length"
          value={r.lengthM ? `${(r.lengthM / 1000).toFixed(1)} km` : "Unknown"}
          muted={!r.lengthM}
        />
      </CardSection>
    </InfoCard>
  );
};
