import React from "react";

import { COMFORT } from "@transitopia/cycling-core/classify.ts";
import type {
  CyclingRouteDetail,
  CyclingRouteLink,
} from "@transitopia/cycling-core/routes.ts";
import {
  CardChips,
  CardRow,
  CardSection,
  InfoCard,
  shareLink,
  type CardAction,
} from "../components/InfoCard.tsx";
import { BIKE_TILE } from "./BikePathCard.tsx";

/** OSM's route networks, in words. */
const NETWORKS: Record<string, string> = {
  lcn: "Local bike route",
  rcn: "Regional bike route",
  ncn: "National bike route",
  icn: "International bike route",
};

/** When the API server (VITE_TRANSIT_API) doesn't answer: bike routes come only from it. */
export const API_UNREACHABLE =
  "Can't reach the Transitopia API server, so bike routes can't be shown.";

/**
 * The comfort levels (COMFORT), most comfortable first, in the map's greens; COMFORT.none is a
 * route's ways that aren't bike facilities, and ferries are apart from them.
 */
const COMFORT_LEVELS = [
  {
    comfort: COMFORT.most,
    label: "Separated from traffic",
    swatch: "bg-[#1a6d23] dark:bg-[#4cc26a]",
  },
  {
    comfort: COMFORT.high,
    label: "Quiet street or shared path",
    swatch: "bg-[#5c9e63] dark:bg-[#33874a]",
  },
  {
    comfort: COMFORT.low,
    label: "Painted bike lane",
    swatch: "bg-[#a5cfa8] dark:bg-[#285e36]",
  },
  {
    comfort: COMFORT.least,
    label: "Busy street or beside parked cars",
    swatch: "bg-[#e0a33a] dark:bg-[#c98a2a]",
  },
  {
    comfort: COMFORT.none,
    label: "No bike facility",
    swatch: "bg-[#c9cdd2] dark:bg-[#4a5058]",
  },
] as const;

const FERRY = {
  key: "ferry",
  label: "Ferry",
  swatch: "bg-[#7fa9d4] dark:bg-[#3f6f9e]",
};

const km = (m: number) => `${(m / 1000).toFixed(1)} km`;

/** A share as a whole percentage, "<1%" for a sliver. */
const percent = (part: number, total: number) => {
  const p = Math.round((part / total) * 100);
  return p === 0 && part > 0 ? "<1%" : `${p}%`;
};

/** A route's length by comfort: a bar, then a row per level it has (and its ferries). */
const ComfortBreakdown: React.FC<{ route: CyclingRouteDetail }> = ({
  route: r,
}) => {
  const levels = [
    ...COMFORT_LEVELS.map((l) => ({
      ...l,
      key: l.comfort,
      m: r.comfortM[l.comfort],
    })),
    { ...FERRY, m: r.ferryM },
  ].filter((l) => l.m > 0);
  const total = levels.reduce((a, l) => a + l.m, 0);
  // Rows only for what's at least 0.1 km; the bar shows everything.
  const rows = levels.filter((l) => l.m >= 50);
  return (
    <CardSection title="Comfort">
      <div
        className="my-2 flex h-2.5 overflow-hidden rounded-full"
        role="img"
        aria-label={levels
          .map((l) => `${l.label} ${percent(l.m, total)}`)
          .join(", ")}>
        {levels.map((l) => (
          <span
            key={l.key}
            className={l.swatch}
            style={{ width: `${(l.m / total) * 100}%` }}
          />
        ))}
      </div>
      {rows.map((l) => (
        <CardRow
          key={l.key}
          label={
            <span className="flex items-center gap-2">
              <span
                className={`h-2.5 w-2.5 flex-none rounded-sm ${l.swatch}`}
              />
              {l.label}
            </span>
          }
          value={`${km(l.m)} · ${percent(l.m, total)}`}
        />
      ))}
    </CardSection>
  );
};

/** A section of bike route chips ("Part of", "Contains"), each opening its route's card. */
export const RouteLinks: React.FC<{
  title: string;
  routes: readonly CyclingRouteLink[];
  onRoute: (route: CyclingRouteLink) => void;
}> = ({ title, routes, onRoute }) =>
  routes.length ?
    <CardSection title={title}>
      <CardChips
        className="py-1.5"
        chips={routes.map((r) => ({
          label: r.name,
          color: BIKE_TILE,
          onSelect: () => onRoute(r),
          action: `View bike route: ${r.name}`,
        }))}
      />
    </CardSection>
  : null;

/**
 * A bike route, an OSM route relation (apps/web/README.md#feature-cards), from the API server
 * (apps/server/README.md#cycling-routes): its length by comfort, the routes it's part of and the
 * ones it contains. The map highlights it whole.
 */
export const CyclingRouteCard: React.FC<{
  route: CyclingRouteDetail;
  onRoute: (route: CyclingRouteLink) => void;
  /** Fit the map to the whole route; none when it has no ways in the area. */
  onShowAll: (() => void) | undefined;
  back?: { label: string; onBack: () => void } | undefined;
  onClose: () => void;
}> = ({ route: r, onRoute, onShowAll, back, onClose }) => {
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
      onSelect: () => shareLink(location.href, `${r.name} · Transitopia`),
    },
  ];
  return (
    <InfoCard
      tile={{ icon: "bicycle", ...BIKE_TILE }}
      eyebrow={(r.network && NETWORKS[r.network]) ?? "Bike route"}
      title={r.name}
      subtitle={r.ref && r.ref !== r.name ? r.ref : undefined}
      actions={actions}
      back={back}
      onClose={onClose}
      footer={
        <>
          <p>From OpenStreetMap, via Transitopia's cycling layer.</p>
          <a
            href={`https://www.openstreetmap.org/relation/${r.osmRelation}`}
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
          value={r.lengthM ? km(r.lengthM) : "Unknown"}
          muted={!r.lengthM}
        />
      </CardSection>
      {r.lengthM ?
        <ComfortBreakdown route={r} />
      : null}
      <RouteLinks title="Part of" routes={r.parents} onRoute={onRoute} />
      <RouteLinks title="Contains" routes={r.subroutes} onRoute={onRoute} />
    </InfoCard>
  );
};
