// Stations from GTFS stops (docs/DESIGN.md#relationships-between-features): a station's name from its
// parent stop's, and same-named stations close together shown as one (Waterfront's SkyTrain, West
// Coast Express and SeaBus stops). Used by the plan build and by feature reconciliation, which
// proposes the same groups.

import { distM } from "../geo.ts";

/** Same-named stations closer than this are one station (m). */
export const STATION_MERGE_M = 400;

/**
 * A station's name from a GTFS stop name: "Waterfront Station", "Waterfront Station @ West Coast
 * Express" → "Waterfront".
 */
export function stationName(stopName: string): string {
  return stopName.replace(/\s+Station\b.*$/, "").replace(/\s+@.*$/, "");
}

/**
 * Stations grouped by name and distance, in the order given: each joins the first group of the same
 * name whose first member is within STATION_MERGE_M, so a group's first member is its position.
 */
export function groupStations<
  T extends { name: string; lon: number; lat: number },
>(stations: readonly T[]): T[][] {
  const groups: T[][] = [];
  for (const s of stations) {
    const g = groups.find(
      ([m]) =>
        m!.name === s.name
        && distM([m!.lon, m!.lat], [s.lon, s.lat]) < STATION_MERGE_M,
    );
    if (g) g.push(s);
    else groups.push([s]);
  }
  return groups;
}
