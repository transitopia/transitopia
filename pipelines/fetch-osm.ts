// Download SkyTrain track data from OpenStreetMap via Overpass (PLAN.md §4.1): every
// railway=subway way (mainline, pockets, crossovers, yards) with node geometry, the railway=switch /
// buffer_stop nodes on them, stop positions, and platforms. Saved with a date so imports are
// reproducible: data/raw/osm/skytrain-YYYY-MM-DD.json (and latest.json).
//
// OSM data © OpenStreetMap contributors, ODbL.

import { mkdir, writeFile, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { RAW_DIR, log } from "./lib/paths.ts";

/** Metro Vancouver, [south, west, north, east] (Overpass order). */
const BBOX = [49.1, -123.3, 49.35, -122.7].join(",");
const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

// Tracks: every railway=subway way, plus route-relation member ways tagged construction/disused
// (existing track under works; see import-osm.ts).
const QUERY = `[out:json][timeout:180];
relation["route"="subway"](${BBOX})->.routes;
way(r.routes)["railway"~"^(construction|disused)$"]->.works;
(
  way["railway"="subway"](${BBOX});
  .works;
)->.tracks;
(
  .tracks;
  node(w.tracks);
)->.trackAll;
(
  node["public_transport"="stop_position"]["subway"="yes"](${BBOX});
  node["railway"="stop"]["subway"="yes"](${BBOX});
  way["railway"="platform"](${BBOX})(around.tracks:30);
  way["public_transport"="platform"]["subway"="yes"](${BBOX});
  relation["route"="subway"](${BBOX});
)->.extra;
(.trackAll; .extra;);
out body;
>;
out skel qt;`;

async function main() {
  const dir = join(RAW_DIR, "osm");
  await mkdir(dir, { recursive: true });
  let lastErr: unknown;
  for (const url of ENDPOINTS) {
    try {
      log(`Querying ${url}`);
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "skytrain-viz/0.1",
        },
        body: new URLSearchParams({ data: QUERY }),
        signal: AbortSignal.timeout(240_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const data = JSON.parse(text) as { elements: { type: string }[] };
      const date = new Date().toISOString().slice(0, 10);
      const out = join(dir, `skytrain-${date}.json`);
      await writeFile(out, text);
      await copyFile(out, join(dir, "latest.json"));
      const counts: Record<string, number> = {};
      for (const e of data.elements) counts[e.type] = (counts[e.type] ?? 0) + 1;
      log(`Saved ${out}: ${JSON.stringify(counts)}`);
      return;
    } catch (e) {
      lastErr = e;
      log(`  failed: ${e instanceof Error ? e.message : e}`);
    }
  }
  throw lastErr;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
