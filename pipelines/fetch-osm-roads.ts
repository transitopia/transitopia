// Download the roads a feed's buses can use from OpenStreetMap via Overpass, for matching bus shapes
// to streets in build-schedule (packages/transit-core/DESIGN.md#bus-corridors): every public road
// class, busways, service roads open to buses, and service roads near bus stops (exchange loops are
// often plain service roads). The area is where the feed's buses go in its newest archived GTFS: the
// cells of a grid (CELL_DEG) its shapes and stops are in, and their neighbours, so a feed of towns
// far apart (BC Transit's Northern BC) doesn't fetch every road between them. Saved with a date so
// builds are reproducible: var/raw/osm-roads/<feed>/YYYY-MM-DD.json (and latest.json).
//
//   tsx pipelines/fetch-osm-roads.ts [--feed <id>]   (default: every feed)
//   tsx pipelines/fetch-osm-roads.ts --max-age-days 30   (only feeds without roads, or older; the
//                                                         nightly data build, pipelines/data.ts)
//
// The newest KEEP_DATED dated files are kept (TransLink's are about 100 MB each). Each feed tries
// every server in turn, and again after a pause (ATTEMPTS); a feed that still fails keeps its
// previous roads, the other feeds are fetched anyway, and the script exits non-zero at the end.
//
// OSM data © OpenStreetMap contributors, ODbL.

import {
  copyFile,
  mkdir,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { archivedFeeds } from "@transitopia/data/gtfs-day.ts";
import { readCsv } from "@transitopia/data/gtfs-zip.ts";
import { feedPaths, log, readFeeds } from "@transitopia/data/paths.ts";

/**
 * Public Overpass servers, tried in order (https://wiki.openstreetmap.org/wiki/Overpass_API#Public_Overpass_API_instances).
 * Busy, overpass-api.de answers 502 at once and kumi 504 after about 4 minutes (2026-11-02);
 * private.coffee is a last resort, not yet seen to answer from here (2026-11-03).
 */
const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];
/**
 * Rounds over every server before a feed gives up, with a pause between them: a busy server often
 * answers a few minutes later (Northern BC failed on both, then worked, 2026-11-02).
 */
const ATTEMPTS = 2;
const RETRY_PAUSE_MS = 2 * 60_000;
const ROAD_CLASSES = [
  "motorway",
  "motorway_link",
  "trunk",
  "trunk_link",
  "primary",
  "primary_link",
  "secondary",
  "secondary_link",
  "tertiary",
  "tertiary_link",
  "unclassified",
  "residential",
  "living_street",
  "road",
  "busway",
  "bus_guideway",
];
/** Dated extracts kept per feed, newest first; older ones are deleted after a fetch. */
const KEEP_DATED = 3;
/** Service roads this close to a bus stop are included (m): exchange loops and bays. */
const SERVICE_NEAR_STOP_M = 150;

function query(boxes: readonly BBox[]): string {
  const bboxes = boxes.map(([west, south, east, north]) =>
    [south, west, north, east].join(","),
  );
  const each = (statement: (bbox: string) => string) =>
    bboxes.map(statement).join("\n");
  return `[out:json][timeout:600];
(
${each((b) => `  way["highway"~"^(${ROAD_CLASSES.join("|")})$"](${b});`)}
${each((b) => `  way["highway"="service"]["bus"~"^(yes|designated)$"](${b});`)}
${each((b) => `  way["highway"="service"]["psv"~"^(yes|designated)$"](${b});`)}
)->.roads;
(
${each((b) => `  node["highway"="bus_stop"](${b});`)}
)->.stops;
way["highway"="service"](around.stops:${SERVICE_NEAR_STOP_M})->.service;
(.roads; .service;)->.ways;
.ways out body qt;
node(w.ways);
out skel qt;`;
}

async function fetchFeed(feed: string, area: readonly BBox[]) {
  const q = query(area);
  const dir = feedPaths(feed).roads;
  await mkdir(dir, { recursive: true });
  let lastErr: unknown;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    if (attempt > 1) {
      log(
        `${feed}: every server failed; trying again in ${RETRY_PAUSE_MS / 60_000} min`,
      );
      await new Promise((r) => setTimeout(r, RETRY_PAUSE_MS));
    }
    for (const url of ENDPOINTS) {
      try {
        log(`${feed}: querying ${url}`);
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "Transitopia (+https://www.transitopia.org)",
          },
          body: new URLSearchParams({ data: q }),
          signal: AbortSignal.timeout(900_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        const data = JSON.parse(text) as { elements: { type: string }[] };
        const out = join(dir, `${new Date().toISOString().slice(0, 10)}.json`);
        await writeFile(out, text);
        await copyFile(out, join(dir, "latest.json"));
        const counts: Record<string, number> = {};
        for (const e of data.elements)
          counts[e.type] = (counts[e.type] ?? 0) + 1;
        log(`${feed}: saved ${out}: ${JSON.stringify(counts)}`);
        const dated = (await readdir(dir))
          .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
          .sort()
          .reverse();
        for (const f of dated.slice(KEEP_DATED)) await rm(join(dir, f));
        return;
      } catch (e) {
        lastErr = e;
        log(`${feed}: ${url} failed: ${String(e)}`);
      }
    }
  }
  throw lastErr;
}

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const only = arg("--feed");
const maxAgeDays = arg("--max-age-days");

/** Whether the feed's roads were fetched within --max-age-days (always false without it). */
async function fresh(feed: string): Promise<boolean> {
  if (maxAgeDays === undefined) return false;
  try {
    const { mtimeMs } = await stat(join(feedPaths(feed).roads, "latest.json"));
    return Date.now() - mtimeMs < Number(maxAgeDays) * 86_400_000;
  } catch {
    return false;
  }
}

type BBox = [number, number, number, number];

/**
 * Roads are fetched for the cells of a grid this size (degrees: about 5.5 km north-south, 3.5 km
 * east-west) that a shape or stop is in, and for the cells around those: a margin of at least a cell
 * for shapes that pass between points or run on past a stop to turn (guess).
 */
const CELL_DEG = 0.05;

/** Where the buses of the feed's newest archived GTFS go, as boxes: runs of cells, row by row. */
async function feedArea(feed: string): Promise<BBox[] | undefined> {
  const [newest] = await archivedFeeds(feed);
  if (!newest) return undefined;
  const rows = new Map<number, Set<number>>();
  const add = (lonV: string | undefined, latV: string | undefined) => {
    const lon = Number(lonV);
    const lat = Number(latV);
    if (!lonV || !latV || !Number.isFinite(lon + lat)) return;
    const i = Math.floor(lon / CELL_DEG);
    const j = Math.floor(lat / CELL_DEG);
    for (let dj = -1; dj <= 1; dj++) {
      let row = rows.get(j + dj);
      if (!row) rows.set(j + dj, (row = new Set()));
      for (let di = -1; di <= 1; di++) row.add(i + di);
    }
  };
  for await (const s of readCsv(newest.path, "stops.txt"))
    add(s.stop_lon, s.stop_lat);
  for await (const p of readCsv(newest.path, "shapes.txt"))
    add(p.shape_pt_lon, p.shape_pt_lat);
  const boxes: BBox[] = [];
  const at = (n: number) => Math.round(n * CELL_DEG * 1e6) / 1e6;
  for (const [j, row] of [...rows].sort(([a], [b]) => a - b)) {
    const cells = [...row].sort((a, b) => a - b);
    let start = cells[0]!;
    for (const [k, i] of cells.entries()) {
      const next = cells[k + 1];
      if (next === i + 1) continue;
      boxes.push([at(start), at(j), at(i + 1), at(j + 1)]);
      if (next !== undefined) start = next;
    }
  }
  return boxes.length ? boxes : undefined;
}

const failed: string[] = [];
for (const feed of await readFeeds()) {
  if (only && feed.id !== only) continue;
  if (await fresh(feed.id)) {
    log(`${feed.id}: roads fetched within ${maxAgeDays} days`);
    continue;
  }
  const area = await feedArea(feed.id);
  if (!area) continue;
  log(`${feed.id}: ${area.length} boxes along its routes`);
  try {
    await fetchFeed(feed.id, area);
  } catch (e) {
    failed.push(feed.id);
    log(
      `${feed.id}: no roads fetched (${String(e)}); keeping the ones fetched before, if any`,
    );
  }
}
if (failed.length) {
  log(`Roads not fetched for ${failed.join(", ")}`);
  process.exitCode = 1;
}
