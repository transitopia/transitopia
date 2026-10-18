// Download the roads a feed's buses can use from OpenStreetMap via Overpass, for matching bus shapes
// to streets in build-schedule (packages/transit-core/DESIGN.md#bus-corridors): every public road
// class, busways, service roads open to buses, and service roads near bus stops (exchange loops are
// often plain service roads). The area is the bbox of the regions showing the feed. Saved with a date
// so builds are reproducible: var/raw/osm-roads/<feed>/YYYY-MM-DD.json (and latest.json).
//
//   tsx pipelines/fetch-osm-roads.ts [--feed <id>]   (default: every feed)
//   tsx pipelines/fetch-osm-roads.ts --max-age-days 30   (only feeds without roads, or older; the
//                                                         nightly data build, pipelines/data.ts)
//
// The newest KEEP_DATED dated files are kept (TransLink's are about 100 MB each).
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
import {
  feedPaths,
  log,
  readFeeds,
  readRegions,
} from "@transitopia/data/paths.ts";

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
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

function query(bbox: string): string {
  return `[out:json][timeout:600];
(
  way["highway"~"^(${ROAD_CLASSES.join("|")})$"](${bbox});
  way["highway"="service"]["bus"~"^(yes|designated)$"](${bbox});
  way["highway"="service"]["psv"~"^(yes|designated)$"](${bbox});
)->.roads;
node["highway"="bus_stop"](${bbox})->.stops;
way["highway"="service"](around.stops:${SERVICE_NEAR_STOP_M})->.service;
(.roads; .service;)->.ways;
.ways out body qt;
node(w.ways);
out skel qt;`;
}

async function fetchFeed(feed: string, bbox: [number, number, number, number]) {
  const [west, south, east, north] = bbox;
  const q = query([south, west, north, east].join(","));
  const dir = feedPaths(feed).roads;
  await mkdir(dir, { recursive: true });
  let lastErr: unknown;
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
      for (const e of data.elements) counts[e.type] = (counts[e.type] ?? 0) + 1;
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

const regions = await readRegions();
for (const feed of await readFeeds()) {
  if (only && feed.id !== only) continue;
  if (await fresh(feed.id)) {
    log(`${feed.id}: roads fetched within ${maxAgeDays} days`);
    continue;
  }
  const shown = regions.filter((r) => r.feeds.includes(feed.id));
  if (!shown.length) continue;
  const bbox: [number, number, number, number] = [
    Math.min(...shown.map((r) => r.bbox[0])),
    Math.min(...shown.map((r) => r.bbox[1])),
    Math.max(...shown.map((r) => r.bbox[2])),
    Math.max(...shown.map((r) => r.bbox[3])),
  ];
  await fetchFeed(feed.id, bbox);
}
