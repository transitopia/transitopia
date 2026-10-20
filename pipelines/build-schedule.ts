// Build the compact service plan for each archived version of each feed, and each feed's manifest.
// Input:  var/raw/gtfs/<feed>/<version dir>/google_transit.zip, config/feeds/<feed>/{feed,routes}.json,
//         its operator's config/operators/<id>/operator.json (the name plans record),
//         and for a region showing the feed with SeaBus berths and lanes:
//         config/regions/<region>/infrastructure/seabus.json + config/regions/<region>/seabus.json,
//         and the feed's OSM roads when fetched (var/raw/osm-roads/<feed>/latest.json, fetch-osm-roads):
//         bus shapes are matched to them and bus corridors built (packages/transit-core/DESIGN.md#bus-corridors)
// Output: var/public/data/feeds/<feed>/<version dir>/plan.json and its parts beside it (shapes,
//         corridors, trips by service: packages/transit-core/DESIGN.md#published-plans),
//         var/public/data/feeds/<feed>/manifest.json
// See packages/transit-core/DESIGN.md#timetables.
//
//   tsx pipelines/build-schedule.ts                     # build versions not yet built, or built from other inputs
//   tsx pipelines/build-schedule.ts --force             # rebuild all
//   tsx pipelines/build-schedule.ts --feed translink    # one feed
//
// A plan records what it was built from besides its feed (`inputs`: PLAN_FORMAT and the files
// above), so editing routes.json or changing what this writes rebuilds existing plans too.

import { createHash } from "node:crypto";
import { open, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { readCsv, readCsvAll, type Row } from "@transitopia/data/gtfs-zip.ts";
import {
  OPERATORS_DIR,
  REGIONS_DIR,
  exists,
  feedPaths,
  log,
  readConfig,
  readFeed,
  readFeedRoutes,
  readFeeds,
  readJson,
  readOperator,
  readRegions,
  writeJson,
} from "@transitopia/data/paths.ts";
import { readPlanCore, writePlan } from "@transitopia/data/plans.ts";
import { shortId } from "@transitopia/transit-core/plan/display.ts";
import type { FeedInfo } from "@transitopia/transit-core/config.ts";
import { selectRoutes } from "@transitopia/transit-core/plan/routes.ts";
import {
  cumulativeLengths,
  projectOnto,
  removeStopSpurs,
  roundLine,
  simplify,
  type LonLat,
  type StopSpurLimits,
} from "@transitopia/transit-core/geo.ts";
import {
  parseGtfsTime,
  TIMEZONE,
  serviceDate,
} from "@transitopia/transit-core/time.ts";
import {
  matchShape,
  RoadGraph,
  type MatchPiece,
  type OsmElement,
} from "@transitopia/transit-core/plan/road-match.ts";
import {
  buildCorridors,
  keptRoadNodes,
  mergeCarriageways,
  roadCoords,
} from "@transitopia/transit-core/plan/corridors.ts";
import {
  applyFerryBerths,
  type FerryInfra,
} from "@transitopia/transit-core/plan/ferry-berths.ts";
import type {
  CalendarEntry,
  CalendarException,
} from "@transitopia/transit-core/gtfs/calendar.ts";
import {
  feedDataPath,
  type FeedManifest,
  type PlanCorridor,
  type PlanPattern,
  type PlanRoute,
  type PlanStation,
  type PlanStop,
  type PlanTrip,
  type RouteKind,
  type ServicePlan,
} from "@transitopia/transit-core/plan/types.ts";
import {
  LINE_DECIMALS,
  STOP_NO_DROPOFF,
  STOP_NO_PICKUP,
} from "@transitopia/transit-core/plan/types.ts";
import { busHubs } from "@transitopia/transit-core/plan/exchanges.ts";
import {
  groupStations,
  stationName,
} from "@transitopia/transit-core/plan/stations.ts";

/** Shape simplification tolerance (m) by route kind: track-level lines keep more detail. */
const SIMPLIFY_M: Record<RouteKind, number> = { skytrain: 1, shape: 3, bus: 4 };
/** Bus shape vertices on a stop that are bumps or spurs to the curb (removeStopSpurs), in metres. */
const STOP_SPURS: StopSpurLimits = { curbM: 10, spurM: 20 };
/** Warn when a stop projects further than this from its trip's shape. */
const STOP_OFFSET_WARN_M = 150;
/**
 * Bump when this script writes something different from the same feed and config (a new field,
 * different filtering), so plans already built are rebuilt. 2: route catalogue and its bays.
 * 3: plans record their feed (config/feeds/<feed>/), and go to its directory. 4: and its agency, and how
 * its ids are shown. 5: bus shapes without spurs to their stops. 6: bus shapes matched to OSM roads,
 * and bus corridors. 7: and overview corridors. 8: matched shapes simplified at 1 m. 9: matched
 * shapes and corridors keep the same road nodes. 10: matching retries every road in range before a
 * break; divided roads merge round bends. 11: repeated shape points don't break a match. 12: bus
 * exchanges and stations' bays (`hubs`). 13: published in parts (plan/published.ts), lines at 5 decimals.
 * 14: weekday figures (routes' `weekdayWait`, combos' `weekday`) and shared stretches' offsets.
 * 15: every route in the feed by default (plan/routes.ts), no catalogue. 16: corridors numbered by
 * their geometry, and their metadata in a part of its own (corridor-info.json) for plan tiles.
 */
const PLAN_FORMAT = 16;

/** Regions showing the feed with SeaBus berths and lanes (infrastructure/seabus.json): build-schedule applies them. */
async function ferryRegions(feed: string): Promise<string[]> {
  const out: string[] = [];
  for (const r of await readRegions())
    if (
      r.feeds.includes(feed)
      && (await exists(
        join(REGIONS_DIR, r.id, "infrastructure", "seabus.json"),
      ))
    )
      out.push(r.id);
  return out;
}

const roadsFile = (feed: string) => join(feedPaths(feed).roads, "latest.json");

/** When the feed's OSM roads were extracted (Overpass's timestamp), or undefined without them. */
async function roadsStamp(feed: string): Promise<string | undefined> {
  if (!(await exists(roadsFile(feed)))) return undefined;
  const handle = await open(roadsFile(feed));
  try {
    const { buffer, bytesRead } = await handle.read(
      Buffer.alloc(1024),
      0,
      1024,
      0,
    );
    const head = buffer.subarray(0, bytesRead).toString("utf8");
    return /"timestamp_osm_base":\s*"([^"]+)"/.exec(head)?.[1] ?? "unknown";
  } finally {
    await handle.close();
  }
}

async function loadRoads(feed: string): Promise<RoadGraph | undefined> {
  if (!(await exists(roadsFile(feed)))) {
    log(
      `${feed}: no OSM roads (npm run data:roads); bus shapes stay as in the GTFS`,
    );
    return undefined;
  }
  const osm = JSON.parse(await readFile(roadsFile(feed), "utf8")) as {
    elements: OsmElement[];
  };
  const g = RoadGraph.fromOsm(osm.elements);
  log(`${feed}: road graph with ${g.edgeCount} directed edges`);
  return g;
}

/** What a feed's plans are built from besides the GTFS: PLAN_FORMAT and the files buildPlan reads. */
async function inputsHash(feed: string): Promise<string> {
  const h = createHash("sha256").update(`plan format ${PLAN_FORMAT}\n`);
  const info = await readFeed(feed);
  const files = [
    join(feedPaths(feed).dir, "feed.json"),
    join(feedPaths(feed).dir, "routes.json"),
    join(OPERATORS_DIR, info.operator, "operator.json"),
  ];
  for (const r of await ferryRegions(feed))
    files.push(
      join(REGIONS_DIR, r, "infrastructure", "seabus.json"),
      join(REGIONS_DIR, r, "seabus.json"),
    );
  for (const f of files) h.update(await readFile(f));
  h.update(`roads ${(await roadsStamp(feed)) ?? "none"}\n`);
  return h.digest("hex").slice(0, 16);
}

interface StopTimeRow {
  seq: number;
  stopId: string;
  arr: number;
  dep: number;
  /** STOP_NO_PICKUP | STOP_NO_DROPOFF bits. */
  access: number;
}

export async function buildPlan(
  zipPath: string,
  feed: FeedInfo,
  roads?: RoadGraph,
): Promise<ServicePlan> {
  const routeCfg = await readFeedRoutes(feed.id);
  const gtfsDataset = feed.dataset;

  const [info] = await readCsvAll(zipPath, "feed_info.txt");
  if (!info) throw new Error("feed_info.txt missing");
  // Service days and times are computed in TIMEZONE (packages/transit-core/src/time.ts), so every
  // feed has to be in it until regions carry their own (docs/DESIGN.md#regions-and-feeds).
  for (const a of await readCsvAll(zipPath, "agency.txt"))
    if (a.agency_timezone !== feed.timezone || feed.timezone !== TIMEZONE)
      throw new Error(
        `${feed.id}: agency ${a.agency_name} is in ${a.agency_timezone} and the feed says ${feed.timezone}; only ${TIMEZONE} is supported`,
      );

  // Routes: every one in the feed, as routes.json overrides or excludes them (matched by name).
  const selected = selectRoutes(
    await readCsvAll(zipPath, "routes.txt"),
    routeCfg,
    gtfsDataset,
  );
  for (const { row, reason } of selected.skipped)
    log(
      `  left out ${row.route_short_name || row.route_long_name || row.route_id}: ${reason}`,
    );
  for (const c of selected.unmatched)
    log(`  warn: routes.json entry ${c.key} matches no route in this feed`);
  const routeByGtfsId = new Map(selected.routes.map((r) => [r.gtfsRouteId, r]));

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
    if (row.stop_code) s.code = row.stop_code;
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
  // Stops each shape's trips serve, for removeStopSpurs.
  const shapeStops = new Map<string, Set<string>>();
  for (const t of rawTrips.values()) {
    let set = shapeStops.get(t.shape);
    if (!set) shapeStops.set(t.shape, (set = new Set()));
    for (const st of stopTimes.get(t.id) ?? []) set.add(st.stopId);
  }
  const shapes: Record<string, LonLat[]> = {};
  const matched = new Map<string, MatchPiece[]>();
  let matchedShare = 0;
  let spurs = 0;
  for (const [id, pts] of shapePts) {
    pts.sort((a, b) => a.seq - b.seq);
    const kind = shapeKind.get(id) ?? "bus";
    let coords = pts.map((x) => x.p);
    if (kind === "bus") {
      const served = [...(shapeStops.get(id) ?? [])].map((sid): LonLat => {
        const s = stops[stopIndex.get(sid)!]!;
        return [s.lon, s.lat];
      });
      const before = coords.length;
      coords = removeStopSpurs(coords, served, STOP_SPURS);
      spurs += before - coords.length;
      if (roads) {
        const m = matchShape(roads, coords);
        matched.set(id, m.pieces);
        matchedShare += m.matched;
        continue;
      }
    }
    const simplified = simplify(coords, SIMPLIFY_M[kind]);
    shapes[id] = roundLine(simplified, LINE_DECIMALS);
  }
  // Matched shapes keep the same road nodes as each other and as the corridors, so lines along
  // the same road coincide (packages/transit-core/DESIGN.md#bus-corridors).
  const keep =
    roads ? keptRoadNodes(roads, [...matched.values()]) : new Set<number>();
  if (roads)
    for (const [id, pieces] of matched)
      shapes[id] = roadCoords(roads, pieces, keep);
  if (spurs)
    log(`Removed ${spurs} shape vertices on stops (spurs to the curb)`);
  if (matched.size)
    log(
      `Matched ${matched.size} bus shapes to roads (${((100 * matchedShare) / matched.size).toFixed(1)}% of their length)`,
    );
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
  // Routes without trips (HandyDART's placeholder, a route between timetables) aren't drawn.
  const withTrips = new Set(patterns.map((p) => p.route));
  const routes = selected.routes.filter((r) => withTrips.has(r.key));
  log(
    `${routes.length} routes (${routes.filter((r) => r.kind === "bus").length} bus)${
      routes.length < selected.routes.length ?
        `; without trips: ${selected.routes
          .filter((r) => !withTrips.has(r.key))
          .map((r) => r.key)
          .join(", ")}`
      : ""
    }`,
  );

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
      name: stationName(row.stop_name!),
      lon: Number(row.stop_lon),
      lat: Number(row.stop_lat),
      routes: [...rs],
    });
  }
  // Merge same-named stations close together (e.g. standalone WCE stops beside the SkyTrain
  // station of the same name), keeping the first (parent) station's position.
  const merged = groupStations(
    stations.sort(
      (a, b) => b.routes.length - a.routes.length || a.id.localeCompare(b.id),
    ),
  ).map(([first, ...rest]) => ({
    ...first!,
    routes: [...new Set([first!, ...rest].flatMap((s) => s.routes))],
  }));
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
      start: serviceDate(r.start_date!),
      end: serviceDate(r.end_date!),
    }));
  const exceptions: CalendarException[] = (
    await readCsvAll(zipPath, "calendar_dates.txt")
  )
    .filter((r) => usedServices.has(r.service_id!))
    .map((r) => ({
      serviceId: r.service_id!,
      date: serviceDate(r.date!),
      type: r.exception_type === "1" ? 1 : 2,
    }));

  const plan: ServicePlan = {
    schema: 1,
    feed: feed.id,
    agency: (await readOperator(feed.operator)).name,
    feedLabel: shortId(feed.display?.feedVersion, info.feed_version!),
    ...(feed.display?.tripId ? { tripIdPattern: feed.display.tripId } : {}),
    feedVersion: info.feed_version!,
    feedStart: serviceDate(info.feed_start_date!),
    feedEnd: serviceDate(info.feed_end_date!),
    timezone: TIMEZONE,
    builtAt: new Date().toISOString(),
    routes,
    stops,
    stations,
    shapes,
    patterns,
    trips,
    calendar: { calendar, exceptions },
    // The plan's own grouping of bays; the browser never runs busHubs (it groups by the
    // registry's places file where there is one).
    hubs: busHubs({ routes, stops, stations, patterns, trips }),
  };
  if (roads && matched.size) {
    const corridors = buildCorridors(
      roads,
      patterns.flatMap((p) => {
        const pieces = matched.get(p.shape);
        return pieces ? [{ pattern: p.id, pieces }] : [];
      }),
      keep,
    );
    // Numbered by their geometry (then their patterns): their index is their feature id in the
    // plan's tiles, so a feed version whose corridors didn't change gets the same tiles.
    plan.corridors = byGeometry(corridors);
    plan.overviewCorridors = byGeometry(mergeCarriageways(corridors));
    log(
      `Built ${corridors.length} bus corridors (${plan.overviewCorridors.length} with divided roads merged)`,
    );
  }

  // SeaBus: berth-to-berth paths along the keep-right lanes instead of the GTFS shapes.
  for (const region of await ferryRegions(feed.id)) {
    const infra = await readJson<FerryInfra>(
      join(REGIONS_DIR, region, "infrastructure", "seabus.json"),
    );
    if (!plan.routes.some((r) => r.key === infra.route)) continue;
    const ferry = applyFerryBerths(
      plan,
      infra,
      await readConfig("seabus", region),
    );
    if (ferry.sharedBerthS > 0)
      log(
        `  warn: SeaBus vessels are docked at the same berth for ${ferry.sharedBerthS} s`,
      );
    else
      log(
        `  SeaBus: one berth pair for all vessels; berths free for ≥ ${Math.round(ferry.minBerthGapS / 60)} min between vessels`,
      );
  }
  return plan;
}

/** Corridors in an order worked out from their coordinates, and patterns where those are the same. */
function byGeometry<T extends PlanCorridor>(corridors: T[]): T[] {
  const key = (c: T) => JSON.stringify(c.coords);
  const keys = new Map(corridors.map((c) => [c, key(c)]));
  const refs = (c: T) => JSON.stringify(c.refs ?? []);
  return corridors.sort((a, b) => {
    const ka = keys.get(a)!;
    const kb = keys.get(b)!;
    return (
      ka < kb ? -1
      : ka > kb ? 1
      : refs(a).localeCompare(refs(b))
    );
  });
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

/** A feed's manifest: every version built, from its plans. */
export async function buildManifest(feed: string): Promise<FeedManifest> {
  const out = feedPaths(feed).out;
  const feeds: FeedManifest["feeds"] = [];
  const dirs = (await exists(out)) ? await readdir(out) : [];
  for (const v of dirs.sort()) {
    const p = join(out, v, "plan.json");
    if (!(await exists(p))) continue;
    const plan = await readPlanCore(p);
    feeds.push({
      version: plan.feedVersion,
      start: plan.feedStart,
      end: plan.feedEnd,
      path: feedDataPath(feed, plan.feedVersion, "plan.json"),
      builtAt: plan.builtAt,
    });
  }
  const manifest: FeedManifest = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    feeds,
  };
  await writeJson(feedPaths(feed).manifest, manifest, true);
  return manifest;
}

async function buildFeed(feed: FeedInfo, force: boolean): Promise<void> {
  const raw = feedPaths(feed.id).raw;
  const versions = (await exists(raw)) ? await readdir(raw) : [];
  const inputs = await inputsHash(feed.id);
  let built = 0;
  let roads: Promise<RoadGraph | undefined> | undefined;
  for (const v of versions.sort()) {
    const zip = join(raw, v, "google_transit.zip");
    if (!(await exists(zip))) continue;
    const out = join(feedPaths(feed.id).out, v, "plan.json");
    const was =
      (await exists(out)) ?
        ((await readPlanCore(out)).inputs ?? "none")
      : undefined;
    if (!force && was === inputs) continue;
    log(
      `${feed.id}: building plan for feed ${v}${
        force ? ""
        : was === undefined ? " (new)"
        : " (config or plan format changed)"
      }`,
    );
    roads ??= loadRoads(feed.id);
    const plan = await buildPlan(zip, feed, await roads);
    plan.inputs = inputs;
    const size = await writePlan(out, plan);
    log(`Wrote ${out} and its parts (${(size / 1e6).toFixed(1)} MB)`);
    built++;
  }
  const manifest = await buildManifest(feed.id);
  log(
    `${feed.id} manifest: ${manifest.feeds.map((f) => `${f.version} [${f.start}–${f.end}]`).join(", ") || "(empty)"}`,
  );
  if (!built) log(`${feed.id}: nothing new to build (use --force to rebuild)`);
}

async function main() {
  const force = process.argv.includes("--force");
  const i = process.argv.indexOf("--feed");
  const only = i >= 0 ? process.argv[i + 1] : undefined;
  for (const feed of only ? [await readFeed(only)] : await readFeeds())
    await buildFeed(feed, force);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
