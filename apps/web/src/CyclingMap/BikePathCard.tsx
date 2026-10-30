import React from "react";

import type { CyclingRouteLink } from "@transitopia/cycling-core/routes.ts";
import {
  CardRow,
  CardSection,
  InfoCard,
  shareLink,
  type CardAction,
  type CardChip,
} from "../components/InfoCard.tsx";
import type { MapCyclingElement } from "../Map/MapData.ts";
import type { RouteState } from "./cycling-data.ts";
import { API_UNREACHABLE, RouteLinks } from "./CyclingRouteCard.tsx";

/** Bike cards use the cycling mode's green (OpenStreetMap features have no route colour). */
export const BIKE_TILE = { bg: "#5cc88d", fg: "#0b3d23" };

/** What kind of facility this is, from the tiles' attributes (packages/cycling-core/src/classify.ts). */
function kind(f: MapCyclingElement): string {
  if (f.class === "ferry") return "Ferry";
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
  if (f.class === "ferry") return [{ label: "Takes bikes", tone: "info" }];
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

/** The bike route relations a path is part of directly, from the tiles' `routes`. */
export const pathRoutes = (f: MapCyclingElement): number[] =>
  f.routes ? f.routes.split(",").map(Number) : [];

/** "Part of": the routes a path is in, then the routes those are in (nearest first), each once. */
function partOf(routes: readonly RouteState[]): CyclingRouteLink[] {
  const found = routes.flatMap((s) => (s.state === "found" ? [s.route] : []));
  const seen = new Set<string>();
  return [...found, ...found.flatMap((r) => r.ancestors)].filter(
    (r) => !seen.has(r.key) && !!seen.add(r.key),
  );
}

/** A bike lane or path (apps/web/README.md#feature-cards). Ignores the map's time: OSM has no history. */
export const BikePathCard: React.FC<{
  feature: MapCyclingElement;
  /** The bike routes it's part of directly (`pathRoutes`), as the API server answers. */
  routes: readonly RouteState[];
  onRoute: (route: CyclingRouteLink) => void;
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
      tile={{
        icon: f.class === "ferry" ? "directions-boat" : "bicycle",
        ...BIKE_TILE,
      }}
      eyebrow={f.class === "ferry" ? "Ferry" : "Bikeway"}
      title={title}
      subtitle={f.name && f.class !== "ferry" ? type : undefined}
      chips={chips(f)}
      actions={actions}
      onClose={onClose}
      footer={<p>From OpenStreetMap, via Transitopia's cycling layer.</p>}>
      {f.class === "ferry" ?
        f.operator ?
          <CardSection title="Details">
            <CardRow label="Operator" value={f.operator} />
          </CardSection>
        : null
      : <CardSection title="Details">
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
      }
      {routes.some((s) => s.state === "unreachable") ?
        <CardSection title="Part of">
          <p role="alert" className="py-2 text-[13.5px] text-(--card-muted)">
            {API_UNREACHABLE}
          </p>
        </CardSection>
      : <RouteLinks title="Part of" routes={partOf(routes)} onRoute={onRoute} />
      }
    </InfoCard>
  );
};
