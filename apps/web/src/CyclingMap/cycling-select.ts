// What's selected on /cycling, as a feature key in ?select= (apps/web/README.md#cycling-links): OSM
// refs until cycling features have IDs (issue #229): `osm-relation:<id>` a bike route,
// `osm-way:<id>` a path or lane (any of its chain's ways) or bike parking mapped as an area,
// `osm-node:<id>` bike parking.

import {
  CYCLING_LAYER,
  osmFeatureId,
} from "@transitopia/cycling-core/tiles.ts";
import { parseKey, type FeatureRef } from "@transitopia/shared/features.ts";
import { formatQuery } from "@transitopia/shared/url.ts";
import type { MapCyclingElement, MapParkingElement } from "../Map/MapData.ts";
import type { MapType } from "../Map/MapUtils.ts";
import { mapSource } from "./cycling-map-layers.ts";

export type CyclingElement = MapCyclingElement | MapParkingElement;

/** An OSM ref the cycling map can select, or undefined. */
export function osmRef(key: string): FeatureRef | undefined {
  const k = parseKey(key);
  return (
      k?.form === "ref"
        && (k.scheme === "osm-relation"
          || k.scheme === "osm-way"
          || k.scheme === "osm-node")
        && /^\d+$/.test(k.value)
    ) ?
      k
    : undefined;
}

/** A path's or bike parking's key: a path is named by its first way by id, as its tile id is. */
export function keyOfElement(f: CyclingElement): string {
  if (f.type === "bicycle_parking")
    return f.osmWayId === undefined ?
        `osm-node:${f.osmNodeId}`
      : `osm-way:${f.osmWayId}`;
  return `osm-way:${Math.floor(Number(f.id) / 10)}`;
}

/** Whether a tile feature is what an `osm-way` or `osm-node` ref names. */
export function elementMatches(
  ref: FeatureRef,
  f: { id?: string | number | undefined; properties: Record<string, unknown> },
): boolean {
  const id = Number(ref.value);
  if (ref.scheme === "osm-node") return f.id === osmFeatureId("node", id);
  if (ref.scheme !== "osm-way") return false;
  if (f.id === osmFeatureId("way", id)) return true;
  const ways = f.properties.osmWayIds;
  return typeof ways === "string" && ways.split(",").includes(ref.value);
}

/** A tile feature as a selected element. */
export function asElement(f: {
  id?: string | number | undefined;
  properties: Record<string, unknown>;
}): CyclingElement {
  return {
    ...f.properties,
    id: f.id as string,
    type:
      f.properties.amenity === "bicycle_parking" ?
        "bicycle_parking"
      : "cycling_way",
  } as CyclingElement;
}

/**
 * The path or bike parking a ref names among the tiles the map has loaded, and a point on it (the
 * middle of a tile's piece of a path), or undefined. Paths have ids only from CYCLING_DETAIL_ZOOM.
 */
export function findLoaded(
  map: MapType,
  ref: FeatureRef,
): { element: CyclingElement; at: [number, number] } | undefined {
  if (!map.getSource(mapSource)) return undefined;
  const f = map
    .querySourceFeatures(mapSource, { sourceLayer: CYCLING_LAYER })
    .find((f) => f.id !== undefined && elementMatches(ref, f));
  if (!f) return undefined;
  const g = f.geometry;
  const at =
    g.type === "Point" ? g.coordinates
    : g.type === "LineString" ?
      g.coordinates[Math.floor(g.coordinates.length / 2)]!
    : undefined;
  return at && { element: asElement(f), at: [at[0]!, at[1]!] };
}

/** The key in ?select=, if it's a valid one. */
export function readSelect(): string | undefined {
  const s = new URLSearchParams(location.search).get("select");
  return s && parseKey(s) ? s : undefined;
}

/** Write the selection to ?select=, keeping the map position (the hash). */
export function writeSelect(key: string | undefined): void {
  const q = new URLSearchParams(location.search);
  if (key) q.set("select", key);
  else q.delete("select");
  const search = formatQuery(q);
  const url = `${location.pathname}${search ? `?${search}` : ""}${location.hash}`;
  if (url !== `${location.pathname}${location.search}${location.hash}`)
    history.replaceState(history.state, "", url);
}
