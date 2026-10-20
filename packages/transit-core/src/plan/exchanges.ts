// Bus exchanges (packages/transit-core/DESIGN.md#departures): the bays of a bus exchange or loop
// ("UBC Exchange @ Bay 7") gathered into one place, so a card can list everything leaving it. Bays
// beside a station ("Joyce Station @ Bay 4") belong to that station instead. GTFS gives bays no
// parent_station, so they're grouped by name and distance.

import { distM, type LonLat } from "../geo.ts";
import {
  isPassengerStop,
  type PlanHub,
  type PlanStop,
  type ServicePlan,
} from "./types.ts";

/** A bus exchange or a station's bays (`ServicePlan.hubs`). */
export type BusHub = PlanHub;

/** Bays of the same exchange within this distance of another of its bays are one exchange (m). */
const MERGE_M = 250;
/**
 * A cluster of bays within this distance of a station, whose name starts with the station's first
 * word, are the station's bays (m): bay names don't always match ("Joyce Station" at
 * Joyce-Collingwood, "Scott Rd Station" at Scott Road), but nearby yet separate exchanges (Haney
 * Place by Port Haney) don't share it.
 */
const STATION_M = 400;

// Agencies name bays differently; both forms are read here (generic heuristics, no agency switch):
//   TransLink:  "UBC Exchange @ Bay 7", "Joyce Station @ Bay 1 Unload Only", "Phibbs Exchange @"
//   BC Transit: "Langford Exch (Jacklin Rd) Bay D", "UBCO Exchange Bay C", "Legislature Exch",
//               "Swartz Bay Ferry Terminal Bay A"

/**
 * "Bay 7", "Bay 5A", "Bay 1 Unload Only", "Unloading Only", or "" ("Phibbs Exchange @"): a bay, not
 * a street stop. A bay is a number or one letter: "@ Bay St" and "@ Bay Mill Rd" are streets.
 */
const BAY = /@\s*(Bay\s+(?:[0-9]+[A-Z]?|[A-Z])\b.*|Unload.*)?$/i;
/**
 * An exchange or terminal, optionally the street a group of its bays is on, then a bay letter or
 * number ("Bay St" is a street: a bay is one letter or a number). The exchange itself (no bay) only
 * when the name ends with it.
 */
const SUFFIX_BAY =
  /^(.*\b(?:Exch|Exchange|Terminal))(?:\s*\([^)]*\))?\s+Bay\s+([0-9]+|[A-Z])\s*$/i;
const SUFFIX_EXCHANGE = /^(.*\b(?:Exch|Exchange))\s*$/i;
/** A street stop named for the exchange it's beside ("Cooper Rd at Orchard Park Exchange"). */
const BESIDE = /\bat\b/i;
/** A direction before the place ("Southbound White Rock Centre @ Bay 11"). */
const DIRECTION = /^(?:North|South|East|West)bound\s+/i;

/** Whether a GTFS stop name is an exchange or station bay. */
export function isBay(name: string): boolean {
  if (name.includes("@")) return BAY.test(name) && !/@\s*Layover\b/i.test(name);
  return (
    SUFFIX_BAY.test(name) || (SUFFIX_EXCHANGE.test(name) && !BESIDE.test(name))
  );
}

/** The bay's number or letter ("7" for "… @ Bay 7", "D" for "… Exch Bay D"), if it has one. */
export function bayNumber(name: string): string | undefined {
  return (
    /@\s*Bay\s+([0-9]+[A-Z]?|[A-Z])\b/i.exec(name)?.[1]
    ?? SUFFIX_BAY.exec(name)?.[2]
  );
}

/** A bay's short name: "Bay 7", "Unloading Only", or "Bay" where it has none ("Phibbs Exchange @"). */
export function bayLabel(name: string): string {
  const n = bayNumber(name);
  if (n !== undefined) return `Bay ${n}`;
  return name.split("@")[1]?.replace(/\s+/g, " ").trim() || "Bay";
}

/**
 * The exchange's or station's name, whitespace tidied: "Oakridge-41st Ave Station  @ Bay 4" →
 * "Oakridge-41st Ave Station", "Langford Exch (Jacklin Rd) Bay D" → "Langford Exchange",
 * "Southbound White Rock Centre @ Bay 11" → "White Rock Centre".
 */
export function baseName(name: string): string {
  const base =
    name.includes("@") ?
      name.split("@")[0]!
    : (SUFFIX_BAY.exec(name)?.[1] ?? SUFFIX_EXCHANGE.exec(name)?.[1] ?? name);
  return base
    .replace(DIRECTION, "")
    .replace(/\bExch$/i, "Exchange")
    .replace(/\s+/g, " ")
    .trim();
}

const firstWord = (name: string) => name.toLowerCase().split(/[\s-]+/)[0] ?? "";

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** By bay number, numbers numerically; unnumbered (unloading) bays last. */
export function byBay(a: PlanStop, b: PlanStop): number {
  const x = bayNumber(a.name);
  const y = bayNumber(b.name);
  if (x === undefined || y === undefined)
    return (
      x === y ? a.name.localeCompare(b.name)
      : x === undefined ? 1
      : -1
    );
  return x.localeCompare(y, undefined, { numeric: true });
}

/** A proposed group of bays: an exchange's, or a station's. */
export interface BayGroup {
  /** The exchange's name ("UBC Exchange"), or the station's for its bays. */
  name: string;
  /** Stop ids of its bays, in the order given. */
  bays: string[];
  /** The id of the station whose bays these are; absent for an exchange on its own. */
  station?: string;
}

type Located = { id: string; name: string; lon: number; lat: number };

/**
 * Bays grouped into exchanges and stations' bays, by name and distance (GTFS gives bays no parent):
 * bays of the same name each within MERGE_M of another are one exchange, and a group within
 * STATION_M of a station whose name starts with the same word is that station's. Every bay given is
 * in one group. What `busHubs` builds on, and what feature reconciliation proposes for new bays
 * (packages/transit-core/DESIGN.md#bus-exchanges).
 */
export function groupBays(
  bays: readonly Located[],
  stations: readonly Located[],
): BayGroup[] {
  // Clusters: same name, each bay within MERGE_M of another.
  const clusters: { name: string; stops: Located[] }[] = [];
  const at = (s: Located): LonLat => [s.lon, s.lat];
  for (const s of bays) {
    const name = baseName(s.name);
    const near = clusters.filter(
      (c) =>
        c.name.toLowerCase() === name.toLowerCase()
        && c.stops.some((o) => distM(at(o), at(s)) < MERGE_M),
    );
    if (!near.length) {
      clusters.push({ name, stops: [s] });
      continue;
    }
    // Join, merging clusters this bay bridges.
    const [first, ...rest] = near;
    first!.stops.push(s, ...rest.flatMap((c) => c.stops));
    for (const c of rest) clusters.splice(clusters.indexOf(c), 1);
  }
  // Each cluster to its station, if any; a station's clusters are one group ("Scott Rd Station" and
  // "Scott Road Station" bays are both Scott Road's).
  const groups = new Map<string, BayGroup>();
  for (const c of clusters) {
    let best: { id: string; name: string; d: number } | undefined;
    for (const st of stations) {
      if (firstWord(st.name) !== firstWord(c.name)) continue;
      const d = Math.min(...c.stops.map((s) => distM(at(s), at(st))));
      if (d < STATION_M && (!best || d < best.d))
        best = { id: st.id, name: st.name, d };
    }
    const key = best ? `station:${best.id}` : `name:${c.name}`;
    const g = groups.get(key);
    if (g) g.bays.push(...c.stops.map((s) => s.id));
    else
      groups.set(key, {
        name: best ? best.name : c.name,
        bays: c.stops.map((s) => s.id),
        ...(best ? { station: best.id } : {}),
      });
  }
  return [...groups.values()];
}

/**
 * The drawn bus routes passengers can board at each of the plan's stops (by stop index), and the
 * stops rail and ferry trips call at (`nonBus`).
 */
export function busStopRoutes(
  plan: Pick<ServicePlan, "routes" | "patterns" | "trips" | "stops">,
): Map<number, Set<string>> & { nonBus: Set<number> } {
  const busRoutes = new Set(
    plan.routes.filter((r) => r.kind === "bus").map((r) => r.key),
  );
  const used = new Set(plan.trips.map((t) => t.pattern));
  const out = Object.assign(new Map<number, Set<string>>(), {
    nonBus: new Set<number>(),
  });
  for (const p of plan.patterns) {
    if (!used.has(p.id)) continue;
    if (!busRoutes.has(p.route)) {
      for (const si of p.stops) out.nonBus.add(si);
      continue;
    }
    p.stops.forEach((si, i) => {
      if (!isPassengerStop(p, i)) return;
      let r = out.get(si);
      if (!r) out.set(si, (r = new Set()));
      r.add(p.route);
    });
  }
  return out;
}

/** What `busHubs` reads: the plan's routes, stops, stations and trips. */
export type HubPlan = Pick<
  ServicePlan,
  "routes" | "stops" | "stations" | "patterns" | "trips"
>;

/** The plan's bus exchanges and stations' bus bays, from the bays its bus patterns stop at. */
export function busHubs(plan: HubPlan): BusHub[] {
  const bays = new Map<number, Set<string>>();
  for (const [si, r] of busStopRoutes(plan))
    if (isBay(plan.stops[si]!.name)) bays.set(si, r);
  const indexOf = new Map(plan.stops.map((s, i) => [s.id, i]));
  const groups = groupBays(
    [...bays.keys()].map((si) => plan.stops[si]!),
    plan.stations,
  );
  const hubs = groups.map((g) => ({
    ...g,
    stops: g.bays.map((id) => indexOf.get(id)!),
  }));
  const out: BusHub[] = [];
  const ids = new Set<string>();
  for (const h of hubs) {
    const stops = h.stops.map((si) => plan.stops[si]!).sort(byBay);
    let id = slug(h.name);
    for (let n = 2; ids.has(id); n++) id = `${slug(h.name)}-${n}`;
    ids.add(id);
    out.push({
      id,
      name: h.name,
      lon: stops.reduce((s, x) => s + x.lon, 0) / stops.length,
      lat: stops.reduce((s, x) => s + x.lat, 0) / stops.length,
      bays: stops.map((s) => s.id),
      routes: [...new Set(h.stops.flatMap((si) => [...bays.get(si)!]))].sort(),
      ...(h.station ? { station: h.station } : {}),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
