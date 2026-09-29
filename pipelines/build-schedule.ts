// Build the compact service plan for each archived GTFS feed version, and the feed manifest.
// Input:  var/raw/gtfs/<version>/google_transit.zip, regions/metro-vancouver/config/routes.json,
//         regions/metro-vancouver/infrastructure/seabus.json + regions/metro-vancouver/config/seabus.json (SeaBus berths and lanes)
// Output: var/public/data/feeds/<version>/plan.json, var/public/data/manifest.json
// See docs/skytrain-viz-PLAN.md §4.2.
//
//   tsx pipelines/build-schedule.ts            # build any feed version not yet built
//   tsx pipelines/build-schedule.ts --force    # rebuild all

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { readCsv, readCsvAll, type Row } from "./lib/gtfs-zip.ts";
import {
  CONFIG_DIR,
  INFRA_DIR,
  GTFS_RAW_DIR,
  PUBLIC_DATA_DIR,
  FEEDS_OUT_DIR,
  log,
  readJson,
  writeJson,
} from "./lib/paths.ts";
import {
  cumulativeLengths,
  distM,
  projectOnto,
  round,
  simplify,
  type LonLat,
} from "@transitopia/transit-core/geo.ts";
import { parseGtfsTime, TIMEZONE } from "@transitopia/transit-core/time.ts";
import {
  applyFerryBerths,
  type FerryConfig,
  type FerryInfra,
} from "@transitopia/transit-core/plan/ferry-berths.ts";
import type {
  CalendarEntry,
  CalendarException,
} from "@transitopia/transit-core/gtfs/calendar.ts";
import type {
  FeedManifest,
  PlanPattern,
  PlanRoute,
  PlanStation,
  PlanStop,
  PlanTrip,
  RouteKind,
  RouteMode,
  ServicePlan,
} from "@transitopia/transit-core/plan/types.ts";
import {
  STOP_NO_DROPOFF,
  STOP_NO_PICKUP,
} from "@transitopia/transit-core/plan/types.ts";

interface RouteConfig {
  key: string;
  label: string;
  match: Partial<Record<"route_long_name" | "route_short_name", string>>;
  kind: RouteKind;
  mode: RouteMode;
  color?: string;
}

/** Shape simplification tolerance (m) by route kind: track-level lines keep more detail. */
const SIMPLIFY_M: Record<RouteKind, number> = { skytrain: 1, shape: 3, bus: 4 };
/** Warn when a stop projects further than this from its trip's shape. */
const STOP_OFFSET_WARN_M = 150;
/** Same-named stations closer than this are one station on the map. */
const STATION_MERGE_M = 400;

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function matchRoute(row: Row, cfg: RouteConfig[]): RouteConfig | undefined {
  return cfg.find((c) =>
    Object.entries(c.match).every(
      ([field, value]) =>
        (row[field] ?? "").toLowerCase() === value.toLowerCase(),
    ),
  );
}

function hexColor(v: string | undefined, fallback: string): string {
  return v && /^[0-9a-f]{6}$/i.test(v) ? `#${v.toLowerCase()}` : fallback;
}

interface StopTimeRow {
  seq: number;
  stopId: string;
  arr: number;
  dep: number;
  /** STOP_NO_PICKUP | STOP_NO_DROPOFF bits. */
  access: number;
}

export async function buildPlan(zipPath: string): Promise<ServicePlan> {
  const { routes: routeCfg } = await readJson<{ routes: RouteConfig[] }>(
    join(CONFIG_DIR, "routes.json"),
  );

  const [info] = await readCsvAll(zipPath, "feed_info.txt");
  if (!info) throw new Error("feed_info.txt missing");

  // Routes, matched by name.
  const routes: PlanRoute[] = [];
  const routeByGtfsId = new Map<string, PlanRoute>();
  for (const row of await readCsvAll(zipPath, "routes.txt")) {
    const cfg = matchRoute(row, routeCfg);
    if (!cfg) continue;
    if (routes.some((r) => r.key === cfg.key))
      throw new Error(
        `Route config ${cfg.key} matched more than one GTFS route`,
      );
    const r: PlanRoute = {
      key: cfg.key,
      label: cfg.label,
      kind: cfg.kind,
      mode: cfg.mode,
      color: cfg.color ?? hexColor(row.route_color, "#666666"),
      textColor: hexColor(row.route_text_color, "#ffffff"),
      gtfsRouteId: row.route_id!,
    };
    routes.push(r);
    routeByGtfsId.set(r.gtfsRouteId, r);
  }
  const missing = routeCfg.filter((c) => !routes.some((r) => r.key === c.key));
  if (missing.length)
    throw new Error(
      `Routes not found in feed: ${missing.map((m) => m.key).join(", ")}`,
    );
  routes.sort(
    (a, b) =>
      routeCfg.findIndex((c) => c.key === a.key)
      - routeCfg.findIndex((c) => c.key === b.key),
  );
  log(`Matched ${routes.length} routes`);

  // Trips on those routes.
  interface RawTrip {
    id: string;
    route: PlanRoute;
    service: string;
    direction: number;
    headsign: string;
    block: string;
    shape: string;
  }
  const rawTrips = new Map<string, RawTrip>();
  for await (const row of readCsv(zipPath, "trips.txt")) {
    const route = routeByGtfsId.get(row.route_id!);
    if (!route) continue;
    rawTrips.set(row.trip_id!, {
      id: row.trip_id!,
      route,
      service: row.service_id!,
      direction: Number(row.direction_id || 0),
      headsign: row.trip_headsign ?? "",
      block: row.block_id ?? "",
      shape: row.shape_id ?? "",
    });
  }
  log(`Selected ${rawTrips.size} trips`);

  // Stop times (the big file), kept only for selected trips.
  const stopTimes = new Map<string, StopTimeRow[]>();
  let scanned = 0;
  for await (const row of readCsv(zipPath, "stop_times.txt")) {
    scanned++;
    if (!rawTrips.has(row.trip_id!)) continue;
    let list = stopTimes.get(row.trip_id!);
    if (!list) stopTimes.set(row.trip_id!, (list = []));
    list.push({
      seq: Number(row.stop_sequence),
      stopId: row.stop_id!,
      arr: parseGtfsTime(row.arrival_time ?? ""),
      dep: parseGtfsTime(row.departure_time ?? ""),
      // GTFS: 1 = no pickup / no drop-off (2 and 3 = phone or coordinate with driver: still possible).
      access:
        (row.pickup_type === "1" ? STOP_NO_PICKUP : 0)
        | (row.drop_off_type === "1" ? STOP_NO_DROPOFF : 0),
    });
  }
  log(`Scanned ${scanned.toLocaleString()} stop_times rows`);

  // Stops used, plus their parent stations.
  const usedStopIds = new Set<string>();
  for (const list of stopTimes.values())
    for (const st of list) usedStopIds.add(st.stopId);
  const allStops = new Map<string, Row>();
  for await (const row of readCsv(zipPath, "stops.txt"))
    allStops.set(row.stop_id!, row);
  const stops: PlanStop[] = [];
  const stopIndex = new Map<string, number>();
  for (const id of [...usedStopIds].sort()) {
    const row = allStops.get(id);
    if (!row)
      throw new Error(
        `stop ${id} referenced by stop_times but missing from stops.txt`,
      );
    const s: PlanStop = {
      id,
      name: row.stop_name!,
      lon: Number(row.stop_lon),
      lat: Number(row.stop_lat),
    };
    if (row.parent_station) s.parent = row.parent_station;
    const platform = /@\s*Platform\s+(\w+)/i.exec(s.name)?.[1];
    if (platform) s.platform = platform;
    stopIndex.set(id, stops.length);
    stops.push(s);
  }

  // Shapes used.
  const usedShapes = new Set(
    [...rawTrips.values()].map((t) => t.shape).filter(Boolean),
  );
  const shapePts = new Map<string, { seq: number; p: LonLat }[]>();
  for await (const row of readCsv(zipPath, "shapes.txt")) {
    if (!usedShapes.has(row.shape_id!)) continue;
    let list = shapePts.get(row.shape_id!);
    if (!list) shapePts.set(row.shape_id!, (list = []));
    list.push({
      seq: Number(row.shape_pt_sequence),
      p: [Number(row.shape_pt_lon), Number(row.shape_pt_lat)],
    });
  }
  const shapeKind = new Map<string, RouteKind>();
  for (const t of rawTrips.values()) shapeKind.set(t.shape, t.route.kind);
  const shapes: Record<string, LonLat[]> = {};
  for (const [id, pts] of shapePts) {
    pts.sort((a, b) => a.seq - b.seq);
    const simplified = simplify(
      pts.map((x) => x.p),
      SIMPLIFY_M[shapeKind.get(id) ?? "bus"],
    );
    shapes[id] = simplified.map(([lon, lat]) => [round(lon, 6), round(lat, 6)]);
  }
  const shapeCum = new Map<string, Float64Array>();
  for (const [id, coords] of Object.entries(shapes))
    shapeCum.set(id, cumulativeLengths(coords));

  // Patterns and trips.
  const patterns: PlanPattern[] = [];
  const patternByKey = new Map<string, number>();
  const trips: PlanTrip[] = [];
  let warnedOffsets = 0;
  for (const raw of rawTrips.values()) {
    const list = stopTimes.get(raw.id);
    if (!list || list.length < 2) continue;
    list.sort((a, b) => a.seq - b.seq);
    const key = `${raw.route.key}|${raw.direction}|${raw.shape}|${list.map((s) => `${s.stopId}:${s.access}`).join(",")}`;
    let pid = patternByKey.get(key);
    if (pid === undefined) {
      const coords = shapes[raw.shape];
      const cum = shapeCum.get(raw.shape);
      const dist: number[] = [];
      let along = 0;
      for (const st of list) {
        const s = stops[stopIndex.get(st.stopId)!]!;
        if (coords && cum) {
          const pr = projectOnto(coords, cum, [s.lon, s.lat], along);
          if (pr.offset > STOP_OFFSET_WARN_M && warnedOffsets++ < 20) {
            log(
              `  warn: ${s.name} is ${Math.round(pr.offset)} m from shape ${raw.shape} (${raw.route.key})`,
            );
          }
          along = pr.along;
        }
        dist.push(Math.round(along));
      }
      pid = patterns.length;
      patterns.push({
        id: pid,
        route: raw.route.key,
        direction: raw.direction,
        shape: raw.shape,
        stops: list.map((s) => stopIndex.get(s.stopId)!),
        dist,
        ...(list.some((s) => s.access) ?
          { access: list.map((s) => s.access) }
        : {}),
      });
      patternByKey.set(key, pid);
    }
    const pattern = patterns[pid]!;
    const arrAbs = interpolateMissing(
      list.map((s) => (Number.isNaN(s.arr) ? s.dep : s.arr)),
      pattern.dist,
    );
    const depAbs = interpolateMissing(
      list.map((s) => (Number.isNaN(s.dep) ? s.arr : s.dep)),
      pattern.dist,
    );
    const start = depAbs[0]!;
    const arr = arrAbs.map((t) => t - start);
    const dep = depAbs.map((t) => t - start);
    const trip: PlanTrip = {
      id: raw.id,
      pattern: pid,
      service: raw.service,
      headsign: raw.headsign,
      start,
      arr,
    };
    if (raw.block) trip.block = raw.block;
    if (dep.some((d, i) => d !== arr[i])) trip.dep = dep;
    trips.push(trip);
  }
  if (warnedOffsets > 20)
    log(`  … ${warnedOffsets - 20} more stop/shape offset warnings`);
  trips.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  log(`Built ${patterns.length} patterns, ${trips.length} trips`);

  // Stations: parent stations of non-bus stops (bus stops are too numerous to label).
  const stationRoutes = new Map<string, Set<string>>();
  for (const p of patterns) {
    const route = routes.find((r) => r.key === p.route)!;
    if (route.kind === "bus") continue;
    for (const si of p.stops) {
      const s = stops[si]!;
      const sid = s.parent ?? s.id;
      let set = stationRoutes.get(sid);
      if (!set) stationRoutes.set(sid, (set = new Set()));
      set.add(route.key);
    }
  }
  const stations: PlanStation[] = [];
  for (const [id, rs] of stationRoutes) {
    const row = allStops.get(id);
    if (!row) continue;
    stations.push({
      id,
      // "Waterfront Station", "Waterfront Station @ West Coast Express" → "Waterfront"
      name: row
        .stop_name!.replace(/\s+Station\b.*$/, "")
        .replace(/\s+@.*$/, ""),
      lon: Number(row.stop_lon),
      lat: Number(row.stop_lat),
      routes: [...rs],
    });
  }
  // Merge same-named stations close together (e.g. standalone WCE stops beside the SkyTrain
  // station of the same name), keeping the first (parent) station's position.
  const merged: PlanStation[] = [];
  for (const s of stations.sort(
    (a, b) => b.routes.length - a.routes.length || a.id.localeCompare(b.id),
  )) {
    const twin = merged.find(
      (m) =>
        m.name === s.name
        && distM([m.lon, m.lat], [s.lon, s.lat]) < STATION_MERGE_M,
    );
    if (twin) twin.routes = [...new Set([...twin.routes, ...s.routes])];
    else merged.push(s);
  }
  stations.length = 0;
  stations.push(...merged.sort((a, b) => a.name.localeCompare(b.name)));

  // Calendar.
  const usedServices = new Set(trips.map((t) => t.service));
  const calendar: CalendarEntry[] = (await readCsvAll(zipPath, "calendar.txt"))
    .filter((r) => usedServices.has(r.service_id!))
    .map((r) => ({
      serviceId: r.service_id!,
      days: [
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
        "sunday",
      ].map((d) => r[d] === "1"),
      start: r.start_date!,
      end: r.end_date!,
    }));
  const exceptions: CalendarException[] = (
    await readCsvAll(zipPath, "calendar_dates.txt")
  )
    .filter((r) => usedServices.has(r.service_id!))
    .map((r) => ({
      serviceId: r.service_id!,
      date: r.date!,
      type: r.exception_type === "1" ? 1 : 2,
    }));

  const plan: ServicePlan = {
    schema: 1,
    feedVersion: info.feed_version!,
    feedStart: info.feed_start_date!,
    feedEnd: info.feed_end_date!,
    timezone: TIMEZONE,
    builtAt: new Date().toISOString(),
    routes,
    stops,
    stations,
    shapes,
    patterns,
    trips,
    calendar: { calendar, exceptions },
  };

  // SeaBus: berth-to-berth paths along the keep-right lanes instead of the GTFS shapes.
  const ferry = applyFerryBerths(
    plan,
    await readJson<FerryInfra>(join(INFRA_DIR, "seabus.json")),
    await readJson<FerryConfig>(join(CONFIG_DIR, "seabus.json")),
  );
  if (ferry.sharedBerthS > 0)
    log(
      `  warn: SeaBus vessels are docked at the same berth for ${ferry.sharedBerthS} s`,
    );
  else
    log(
      `  SeaBus: one berth pair for all vessels; berths free for ≥ ${Math.round(ferry.minBerthGapS / 60)} min between vessels`,
    );
  return plan;
}

/** Fill NaN times by linear interpolation on distance between known neighbours. */
export function interpolateMissing(times: number[], dist: number[]): number[] {
  const out = times.slice();
  let prev = -1;
  for (let i = 0; i < out.length; i++) {
    if (Number.isNaN(out[i])) continue;
    if (prev >= 0 && i - prev > 1) {
      const t0 = out[prev]!;
      const t1 = out[i]!;
      const d0 = dist[prev]!;
      const d1 = dist[i]!;
      for (let k = prev + 1; k < i; k++) {
        const f =
          d1 > d0 ? (dist[k]! - d0) / (d1 - d0) : (k - prev) / (i - prev);
        out[k] = Math.round(t0 + (t1 - t0) * f);
      }
    }
    prev = i;
  }
  if (out.some(Number.isNaN))
    throw new Error("Trip has no usable times at its first or last stop");
  return out;
}

export async function buildManifest(): Promise<FeedManifest> {
  const feeds: FeedManifest["feeds"] = [];
  const versions =
    (await exists(FEEDS_OUT_DIR)) ? await readdir(FEEDS_OUT_DIR) : [];
  for (const v of versions.sort()) {
    const p = join(FEEDS_OUT_DIR, v, "plan.json");
    if (!(await exists(p))) continue;
    const plan = await readJson<ServicePlan>(p);
    feeds.push({
      version: plan.feedVersion,
      start: plan.feedStart,
      end: plan.feedEnd,
      path: `data/feeds/${v}/plan.json`,
      builtAt: plan.builtAt,
    });
  }
  const manifest: FeedManifest = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    feeds,
  };
  await writeJson(join(PUBLIC_DATA_DIR, "manifest.json"), manifest, true);
  return manifest;
}

async function main() {
  const force = process.argv.includes("--force");
  const versions =
    (await exists(GTFS_RAW_DIR)) ? await readdir(GTFS_RAW_DIR) : [];
  let built = 0;
  for (const v of versions.sort()) {
    const zip = join(GTFS_RAW_DIR, v, "google_transit.zip");
    if (!(await exists(zip))) continue;
    const out = join(FEEDS_OUT_DIR, v, "plan.json");
    if (!force && (await exists(out))) continue;
    log(`Building plan for feed ${v}`);
    const plan = await buildPlan(zip);
    await writeJson(out, plan);
    const size = (await stat(out)).size;
    log(`Wrote ${out} (${(size / 1e6).toFixed(1)} MB)`);
    built++;
  }
  const manifest = await buildManifest();
  log(
    `Manifest: ${manifest.feeds.map((f) => `${f.version} [${f.start}–${f.end}]`).join(", ") || "(empty)"}`,
  );
  if (!built) log("Nothing new to build (use --force to rebuild)");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
