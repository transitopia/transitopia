// A feed's stops matched to OpenStreetMap's bus stops (docs/DESIGN.md#osm-bus-stops): an OSM
// `highway=bus_stop` node is the same stop as a feed's stop when its `ref` (the number on the sign,
// several separated by ";") is the stop's code and it's within `matchM`. Matched by code only: a
// nearby node without the code may be the stop across the street. The plan build takes a bay's
// letter from it where the GTFS has none, and the registry records it as an `osm-node:` ref.
// OSM data © OpenStreetMap contributors, ODbL.

import type { Config } from "../config.ts";
import { distM } from "../geo.ts";
import { bayNumber } from "../plan/exchanges.ts";

export type OsmStopSettings = Config<"osm-stops">;

/** An OSM bus stop node: its id, position and the tags read here (fetch-osm-roads → bus-stops.json). */
export interface OsmBusStop {
  id: number;
  lon: number;
  lat: number;
  tags: Record<string, string>;
}

/** The tags `osmBusStops` keeps, of everything a bus stop node has. */
export const OSM_STOP_TAGS = ["name", "ref", "local_ref"] as const;

/** A feed's stop, as matched: its code and position. */
export interface MatchableStop {
  code?: string | undefined;
  lon: number;
  lat: number;
}

export interface OsmStopMatch {
  /** The OSM node's id. */
  node: number;
  /** Its bay number or letter, where its tags give one (`osmBay`). */
  bay?: string | undefined;
  /** How far apart they are (m). */
  m: number;
}

/** A bay number or letter as signs show it ("A", "7", "12B"); OSM's local_ref holds other things too ("BC Transit"). */
const BAY_VALUE = /^(?:[0-9]{1,2}[A-Z]?|[A-Z])$/;
/** "Downtown Exchange A", "Queensway Exch F": a letter or number after the exchange's name. */
const EXCHANGE_BAY = /\bExch(?:ange)?\s+([0-9]{1,2}[A-Z]?|[A-Z])$/;

/**
 * The bay a stop node's tags give: `local_ref` (OSM's tag for it), else its name's ("Downtown
 * Exchange Bay F", "Downtown Exchange A", "… @ Bay 7").
 */
export function osmBay(tags: Record<string, string>): string | undefined {
  const local = tags["local_ref"]?.trim();
  if (local && BAY_VALUE.test(local)) return local;
  const name = tags["name"]?.trim();
  if (!name) return undefined;
  return bayNumber({ name }) ?? EXCHANGE_BAY.exec(name)?.[1];
}

/** Overpass elements' bus stop nodes, with only the tags read here. */
export function osmBusStops(
  elements: readonly {
    type: string;
    id: number;
    lon?: number | undefined;
    lat?: number | undefined;
    tags?: Record<string, string> | undefined;
  }[],
): OsmBusStop[] {
  const out: OsmBusStop[] = [];
  const seen = new Set<number>();
  for (const e of elements) {
    if (e.type !== "node" || e.tags?.["highway"] !== "bus_stop") continue;
    if (e.lon === undefined || e.lat === undefined || seen.has(e.id)) continue;
    seen.add(e.id);
    const tags: Record<string, string> = {};
    for (const k of OSM_STOP_TAGS) {
      const v = e.tags[k];
      if (v !== undefined) tags[k] = v;
    }
    out.push({ id: e.id, lon: e.lon, lat: e.lat, tags });
  }
  return out;
}

/**
 * Each stop's OSM node, in the stops' order: the nearest node within `matchM` whose ref lists the
 * stop's code, or undefined. A node two stops would share goes to the nearer one.
 */
export function matchOsmStops(
  stops: readonly MatchableStop[],
  osm: readonly OsmBusStop[],
  settings: OsmStopSettings,
): (OsmStopMatch | undefined)[] {
  const byRef = new Map<string, OsmBusStop[]>();
  for (const n of osm)
    for (const r of (n.tags["ref"] ?? "").split(";")) {
      const ref = r.trim();
      if (!ref) continue;
      let list = byRef.get(ref);
      if (!list) byRef.set(ref, (list = []));
      list.push(n);
    }
  const out: (OsmStopMatch | undefined)[] = stops.map((s) => {
    if (!s.code) return undefined;
    let best: OsmStopMatch | undefined;
    for (const n of byRef.get(s.code) ?? []) {
      const m = distM([s.lon, s.lat], [n.lon, n.lat]);
      if (m <= settings.matchM && (!best || m < best.m))
        best = { node: n.id, bay: osmBay(n.tags), m: Math.round(m) };
    }
    return best;
  });
  const nearest = new Map<number, number>();
  for (const [i, m] of out.entries()) {
    if (!m) continue;
    const j = nearest.get(m.node);
    if (j === undefined || m.m < out[j]!.m) nearest.set(m.node, i);
  }
  return out.map((m, i) => (m && nearest.get(m.node) === i ? m : undefined));
}
