// What feature reconciliation reads from a GTFS feed version (packages/transit-core/src/features/
// reconcile.ts): every stop, station and route in the zip, not only the plan's, since recordings and
// statistics cover every route.

import { readCsv } from "./gtfs-zip.ts";
import type {
  FeedRecords,
  FeedRoute,
  FeedStop,
} from "@transitopia/transit-core/features/reconcile.ts";

/** Bus route types: 3, and the extended bus types (700–799). */
const isBusType = (t: number) => t === 3 || (t >= 700 && t < 800);

export async function readFeedRecords(zip: string): Promise<FeedRecords> {
  const routes: FeedRoute[] = [];
  const nonBusRoutes = new Set<string>();
  for await (const r of readCsv(zip, "routes.txt")) {
    routes.push({
      id: r.route_id!,
      shortName: r.route_short_name ?? "",
      longName: r.route_long_name ?? "",
    });
    if (!isBusType(Number(r.route_type ?? 3))) nonBusRoutes.add(r.route_id!);
  }
  // Stops rail and ferry trips call at: a standalone one is a station's (West Coast Express at
  // Waterfront). Feeds of buses only skip reading their stop times.
  const nonBusStops = new Set<string>();
  if (nonBusRoutes.size) {
    const trips = new Set<string>();
    for await (const t of readCsv(zip, "trips.txt"))
      if (nonBusRoutes.has(t.route_id!)) trips.add(t.trip_id!);
    for await (const st of readCsv(zip, "stop_times.txt"))
      if (trips.has(st.trip_id!)) nonBusStops.add(st.stop_id!);
  }
  const stops: FeedStop[] = [];
  for await (const r of readCsv(zip, "stops.txt")) {
    const type = r.location_type || "0";
    // Entrances, generic nodes and boarding areas aren't features.
    if (type !== "0" && type !== "1") continue;
    const lon = Number(r.stop_lon);
    const lat = Number(r.stop_lat);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    stops.push({
      id: r.stop_id!,
      code: r.stop_code || undefined,
      name: (r.stop_name ?? "").replace(/\s+/g, " ").trim(),
      lon,
      lat,
      station: type === "1",
      parent: r.parent_station || undefined,
      nonBus: nonBusStops.has(r.stop_id!),
    });
  }
  return { stops, routes };
}
