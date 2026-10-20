// The published form of a service plan (packages/transit-core/DESIGN.md#published-plans): a small
// core (plan.json) that names the files holding the rest, so the browser loads only what it shows.
// Shapes and corridors are delta-coded integer coordinates, and trips are columns per service,
// their stop times as the distinct profiles of each pattern. `publishPlan` writes a ServicePlan
// in this form, `assemblePlan` reads it back whole (pipelines and the server), and the browser
// decodes the parts as it loads them (packages/transit-map/src/plans.ts).

import type { LonLat } from "../geo.ts";
import { CorridorFrequency } from "./corridor-frequency.ts";
import {
  LINE_DECIMALS,
  patternStarts,
  type PlanCorridor,
  type PlanFiles,
  type PlanPattern,
  type PlanStop,
  type PlanTrip,
  type ServicePlan,
  type TripFileRef,
} from "./types.ts";

/** Stops keep GTFS's six decimals. */
const STOP_DECIMALS = 6;

/** Service seconds: a day's main trip file covers its trips shown before this. */
const DAY_S = 24 * 3600;
/**
 * Trips arriving at their last stop from this long before DAY_S go in the service's late file, so
 * the next day needs only that: the longest layover shown (`MAX_LAYOVER_S` in schedule/engine.ts,
 * 45 min) plus an hour for delays carried into estimates. Every SkyTrain trip goes there too:
 * track-level playback needs a service's runs whole (movement files reference all of them).
 */
export const LATE_MARGIN_S = 105 * 60;

/** plan.json as published: ServicePlan without its shapes, corridors and trips, which are files beside it. */
export interface PublishedPlan extends Omit<
  ServicePlan,
  | "schema"
  | "stops"
  | "patterns"
  | "shapes"
  | "trips"
  | "corridors"
  | "overviewCorridors"
  | "files"
> {
  schema: 2;
  stops: PublishedStops;
  patterns: PublishedPattern[];
  files: PlanFiles;
}

/** Stops as columns; coordinates delta-coded (`encodeLine`, STOP_DECIMALS). */
export interface PublishedStops {
  id: string[];
  name: string[];
  coords: number[];
  /** "" where a stop has none. */
  code: string[];
  parent: string[];
  platform: string[];
}

/** A pattern with its distances as differences, and its trips' start times per service as differences. */
export interface PublishedPattern extends Omit<PlanPattern, "dist" | "starts"> {
  dist: number[];
  starts: Record<string, number[]>;
}

export interface PublishedShapes {
  schema: 2;
  decimals: number;
  shapes: Record<string, number[]>;
}

export interface PublishedCorridors {
  schema: 2;
  decimals: number;
  coords: number[][];
  /** Per corridor, its combo in the plan's frequency table. */
  combo: number[];
}

/**
 * A service's trips (or its late ones), by pattern then start. Each run of a pattern's trips has
 * its distinct stop-time profiles: arrival offsets as differences from the previous stop's
 * (the first from the start), and, where departures differ, each stop's dwell.
 */
export interface PublishedTrips {
  schema: 2;
  service: string;
  /** [pattern, trips] per run. */
  runs: number[];
  /** Per run, its profiles: [arrival differences] or [arrival differences, dwells]. */
  profiles: number[][][][];
  /** Per trip: start, as the difference from the previous trip's in its run (the first absolute). */
  start: number[];
  /** Per trip: its profile in its run. */
  profile: number[];
  headsigns: string[];
  headsign: number[];
  ids: PublishedIds;
  /** "" (or absent from a numeric coding: never) for a trip without one. */
  blocks: PublishedIds;
}

/** Ids as the differences between numbers when every one is a plain integer, else as strings. */
export type PublishedIds = { n: number[] } | { s: string[] };

// --- Primitives ---

/** Coordinates as integers at `decimals`, each the difference from the previous point. */
export function encodeLine(
  coords: readonly LonLat[],
  decimals: number,
): number[] {
  const f = 10 ** decimals;
  const out: number[] = [];
  let px = 0;
  let py = 0;
  for (const [lon, lat] of coords) {
    const x = Math.round(lon * f);
    const y = Math.round(lat * f);
    out.push(x - px, y - py);
    px = x;
    py = y;
  }
  return out;
}

export function decodeLine(enc: readonly number[], decimals: number): LonLat[] {
  const f = 10 ** decimals;
  const out: LonLat[] = [];
  let x = 0;
  let y = 0;
  for (let i = 0; i + 1 < enc.length; i += 2) {
    x += enc[i]!;
    y += enc[i + 1]!;
    out.push([x / f, y / f]);
  }
  return out;
}

const deltas = (a: readonly number[]) =>
  a.map((v, i) => (i ? v - a[i - 1]! : v));
function sums(a: readonly number[]): number[] {
  const out: number[] = [];
  let s = 0;
  for (const v of a) out.push((s += v));
  return out;
}

const PLAIN_INT = /^(0|[1-9]\d{0,14})$/;
function encodeIds(ids: readonly string[]): PublishedIds {
  return ids.every((id) => PLAIN_INT.test(id)) ?
      { n: deltas(ids.map(Number)) }
    : { s: [...ids] };
}
function decodeIds(ids: PublishedIds): string[] {
  return "n" in ids ? sums(ids.n).map(String) : ids.s;
}

// --- Publishing ---

/** A published plan: its core and the files it names (paths relative to the core). */
export interface PlanPublication {
  core: PublishedPlan;
  files: Map<string, PublishedShapes | PublishedCorridors | PublishedTrips>;
}

/** A whole plan in its published form (the trips, starts and frequency table are worked out from it). */
export function publishPlan(plan: ServicePlan): PlanPublication {
  const files: PlanPublication["files"] = new Map();
  const starts = patternStarts({ patterns: plan.patterns, trips: plan.trips });
  const {
    schema: _schema,
    stops,
    patterns,
    shapes,
    trips,
    corridors,
    overviewCorridors,
    files: _files,
    frequency: _frequency,
    ...rest
  } = plan;

  const shapesFile: PublishedShapes = {
    schema: 2,
    decimals: LINE_DECIMALS,
    shapes: Object.fromEntries(
      Object.entries(shapes).map(([id, c]) => [
        id,
        encodeLine(c, LINE_DECIMALS),
      ]),
    ),
  };
  files.set("shapes.json", shapesFile);
  const refs: PlanFiles = { shapes: "shapes.json", trips: [] };

  // Frequency combos, worked out here once rather than in every browser.
  let frequency: ServicePlan["frequency"];
  if (corridors?.length) {
    const cf = new CorridorFrequency(plan);
    const corridorFile = (cs: readonly PlanCorridor[]): PublishedCorridors => ({
      schema: 2,
      decimals: LINE_DECIMALS,
      coords: cs.map((c) => encodeLine(c.coords, LINE_DECIMALS)),
      combo: [...cf.combosOfCorridors(cs)],
    });
    files.set("corridors.json", corridorFile(corridors));
    refs.corridors = "corridors.json";
    if (overviewCorridors?.length) {
      files.set("corridors-overview.json", corridorFile(overviewCorridors));
      refs.overviewCorridors = "corridors-overview.json";
    }
    frequency = {
      routeDirs: cf.routeDirs,
      combos: cf.combos,
      stopCombo: cf.stopCombos(),
    };
  }

  // Trips by service: those the day after needs in a file of their own (LATE_MARGIN_S).
  const kind = new Map(plan.routes.map((r) => [r.key, r.kind]));
  const byService = new Map<string, PlanTrip[]>();
  for (const t of trips) {
    let list = byService.get(t.service);
    if (!list) byService.set(t.service, (list = []));
    list.push(t);
  }
  for (const [service, list] of [...byService].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const name = service.replace(/[^A-Za-z0-9._-]+/g, "_");
    const late = new Set(
      list.filter(
        (t) =>
          t.start + t.arr.at(-1)! >= DAY_S - LATE_MARGIN_S
          || kind.get(patterns[t.pattern]!.route) === "skytrain",
      ),
    );
    const add = (file: string, part: PlanTrip[], until: number) => {
      files.set(file, encodeTrips(service, part));
      refs.trips.push({ service, path: file, trips: part.length, until });
    };
    let lateUntil = 0;
    for (const t of late)
      lateUntil = Math.max(lateUntil, t.start + t.arr.at(-1)! + LATE_MARGIN_S);
    if (late.size < list.length)
      add(
        `trips/${name}.json`,
        list.filter((t) => !late.has(t)),
        DAY_S,
      );
    if (late.size) add(`trips/${name}.late.json`, [...late], lateUntil);
  }

  const core: PublishedPlan = {
    schema: 2,
    ...rest,
    stops: encodeStops(stops),
    patterns: patterns.map((p, i) => {
      const { starts: _s, ...pattern } = p;
      return {
        ...pattern,
        dist: deltas(p.dist),
        starts: Object.fromEntries(
          Object.entries(starts[i]!)
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([s, list]) => [s, deltas(list)]),
        ),
      };
    }),
    ...(frequency ? { frequency } : {}),
    files: refs,
  };
  return { core, files };
}

function encodeStops(stops: readonly PlanStop[]): PublishedStops {
  return {
    id: stops.map((s) => s.id),
    name: stops.map((s) => s.name),
    coords: encodeLine(
      stops.map((s) => [s.lon, s.lat]),
      STOP_DECIMALS,
    ),
    code: stops.map((s) => s.code ?? ""),
    parent: stops.map((s) => s.parent ?? ""),
    platform: stops.map((s) => s.platform ?? ""),
  };
}

function encodeTrips(
  service: string,
  trips: readonly PlanTrip[],
): PublishedTrips {
  const sorted = [...trips].sort(
    (a, b) =>
      a.pattern - b.pattern || a.start - b.start || a.id.localeCompare(b.id),
  );
  const out: PublishedTrips = {
    schema: 2,
    service,
    runs: [],
    profiles: [],
    start: [],
    profile: [],
    headsigns: [],
    headsign: [],
    ids: { s: [] },
    blocks: { s: [] },
  };
  const headsigns = new Map<string, number>();
  let i = 0;
  while (i < sorted.length) {
    const pattern = sorted[i]!.pattern;
    let j = i;
    while (j < sorted.length && sorted[j]!.pattern === pattern) j++;
    out.runs.push(pattern, j - i);
    const profiles = new Map<string, number>();
    const list: number[][][] = [];
    let prev = 0;
    for (const t of sorted.slice(i, j)) {
      const arr = deltas(t.arr);
      const prof = t.dep ? [arr, t.dep.map((d, k) => d - t.arr[k]!)] : [arr];
      const key = JSON.stringify(prof);
      let p = profiles.get(key);
      if (p === undefined) {
        profiles.set(key, (p = list.length));
        list.push(prof);
      }
      out.profile.push(p);
      out.start.push(t.start - prev);
      prev = t.start;
      let h = headsigns.get(t.headsign);
      if (h === undefined) {
        headsigns.set(t.headsign, (h = out.headsigns.length));
        out.headsigns.push(t.headsign);
      }
      out.headsign.push(h);
    }
    out.profiles.push(list);
    i = j;
  }
  out.ids = encodeIds(sorted.map((t) => t.id));
  const blocks = sorted.map((t) => t.block ?? "");
  out.blocks = blocks.every(Boolean) ? encodeIds(blocks) : { s: blocks };
  return out;
}

// --- Reading ---

/** The core as a ServicePlan without its shapes, corridors and trips (the browser adds them as they load). */
export function decodeCore(core: PublishedPlan): ServicePlan {
  const { schema: _schema, stops, patterns, ...rest } = core;
  return {
    ...rest,
    schema: 1,
    stops: decodeStops(stops),
    patterns: patterns.map((p) => ({
      ...p,
      dist: sums(p.dist),
      starts: Object.fromEntries(
        Object.entries(p.starts).map(([s, list]) => [s, sums(list)]),
      ),
    })),
    shapes: {},
    trips: [],
  };
}

function decodeStops(s: PublishedStops): PlanStop[] {
  const coords = decodeLine(s.coords, STOP_DECIMALS);
  return s.id.map((id, i) => {
    const stop: PlanStop = {
      id,
      name: s.name[i]!,
      lon: coords[i]![0],
      lat: coords[i]![1],
    };
    if (s.code[i]) stop.code = s.code[i];
    if (s.parent[i]) stop.parent = s.parent[i];
    if (s.platform[i]) stop.platform = s.platform[i];
    return stop;
  });
}

export function decodeShapes(f: PublishedShapes): Record<string, LonLat[]> {
  return Object.fromEntries(
    Object.entries(f.shapes).map(([id, enc]) => [
      id,
      decodeLine(enc, f.decimals),
    ]),
  );
}

export function decodeCorridors(f: PublishedCorridors): PlanCorridor[] {
  return f.coords.map((enc, i) => ({
    coords: decodeLine(enc, f.decimals),
    combo: f.combo[i],
  }));
}

export function decodeTrips(f: PublishedTrips): PlanTrip[] {
  const ids = decodeIds(f.ids);
  const blocks = decodeIds(f.blocks);
  const out: PlanTrip[] = [];
  let k = 0;
  for (let r = 0; r * 2 < f.runs.length; r++) {
    const pattern = f.runs[r * 2]!;
    const n = f.runs[r * 2 + 1]!;
    // Trips of a run with the same profile share its arrays (nothing changes them).
    const profiles = f.profiles[r]!.map(([arr, dwell]) => {
      const a = sums(arr!);
      return { arr: a, dep: dwell && a.map((v, i) => v + dwell[i]!) };
    });
    let start = 0;
    for (let i = 0; i < n; i++, k++) {
      start += f.start[k]!;
      const p = profiles[f.profile[k]!]!;
      const trip: PlanTrip = {
        id: ids[k]!,
        pattern,
        service: f.service,
        headsign: f.headsigns[f.headsign[k]!]!,
        start,
        arr: p.arr,
      };
      const block = blocks[k];
      if (block) trip.block = block;
      if (p.dep) trip.dep = p.dep;
      out.push(trip);
    }
  }
  return out;
}

/** Trips in the order build-schedule writes them (by start, then id). */
export function sortTrips(trips: PlanTrip[]): PlanTrip[] {
  return trips.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
}

/**
 * A published plan read back whole, as build-schedule made it, for pipelines and the server: every
 * trip (each once), shapes and corridors. `read` loads a file named relative to the core.
 */
export async function assemblePlan(
  core: PublishedPlan,
  read: (path: string) => Promise<unknown>,
): Promise<ServicePlan> {
  const plan = decodeCore(core);
  // Its trips are all here: nothing should count frequencies from the summaries instead.
  for (const p of plan.patterns) delete p.starts;
  const { files } = core;
  plan.shapes = decodeShapes((await read(files.shapes)) as PublishedShapes);
  if (files.corridors)
    plan.corridors = decodeCorridors(
      (await read(files.corridors)) as PublishedCorridors,
    );
  if (files.overviewCorridors)
    plan.overviewCorridors = decodeCorridors(
      (await read(files.overviewCorridors)) as PublishedCorridors,
    );
  const seen = new Set<string>();
  const trips: PlanTrip[] = [];
  for (const ref of files.trips)
    for (const t of decodeTrips((await read(ref.path)) as PublishedTrips))
      if (!seen.has(t.id)) {
        seen.add(t.id);
        trips.push(t);
      }
  plan.trips = sortTrips(trips);
  delete plan.files;
  return plan;
}

/**
 * The files holding these services' SkyTrain trips: their late files, which have every one
 * (LATE_MARGIN_S). Track-level playback of a date needs them all.
 */
export function railTripFiles(
  files: PlanFiles,
  services: ReadonlySet<string>,
): TripFileRef[] {
  return files.trips.filter(
    (f) => services.has(f.service) && f.path.endsWith(".late.json"),
  );
}

/** The trip files a service date needs from `fromSec` (service seconds) on, given its services. */
export function tripFilesFor(
  files: PlanFiles,
  services: ReadonlySet<string>,
  fromSec: number,
): TripFileRef[] {
  return files.trips.filter(
    (f) => services.has(f.service) && f.until > fromSec,
  );
}
