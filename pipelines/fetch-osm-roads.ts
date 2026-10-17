// Download the roads a feed's buses can use from OpenStreetMap via Overpass, for matching bus shapes
// to streets in build-schedule (packages/transit-core/DESIGN.md#bus-corridors): every public road
// class, busways, service roads open to buses, and service roads near bus stops (exchange loops are
// often plain service roads). The area is the bbox of the regions showing the feed. Saved with a date
// so builds are reproducible: var/raw/osm-roads/<feed>/YYYY-MM-DD.json (and latest.json).
//
//   tsx pipelines/fetch-osm-roads.ts [--feed <id>]   (default: every feed)
//
// OSM data © OpenStreetMap contributors, ODbL.

import { copyFile, mkdir, writeFile } from "node:fs/promises";
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
      return;
    } catch (e) {
      lastErr = e;
      log(`${feed}: ${url} failed: ${String(e)}`);
    }
  }
  throw lastErr;
}

const feedArg = process.argv.indexOf("--feed");
const only = feedArg >= 0 ? process.argv[feedArg + 1] : undefined;
const regions = await readRegions();
for (const feed of await readFeeds()) {
  if (only && feed.id !== only) continue;
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
