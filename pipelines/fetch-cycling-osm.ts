// Fetch the newest published cycling OSM file (pipelines/extract-cycling-osm.ts, run and published
// daily by GitHub Actions) from data/osm/<area>/ at CYCLING_OSM_FROM (default
// https://data.transitopia.org/) into var/raw/osm-cycling/<area>/, checked against its pointer's
// sha256, unless it's there already. What building the tiles needs, without osmium.
//
//   tsx pipelines/fetch-cycling-osm.ts
//
// OSM data © OpenStreetMap contributors, ODbL.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CYCLING_OSM_FROM,
  CYCLING_OSM_POINTER,
  cyclingOsmDataPath,
  readCyclingOsm,
  writeCyclingOsmPointer,
  type CyclingOsmPointer,
} from "@transitopia/data/osm-extracts.ts";
import {
  cyclingPaths,
  log,
  readCyclingConfig,
} from "@transitopia/data/paths.ts";

/** Cycling OPL files kept, newest first. */
const KEEP = 2;

async function get(url: URL): Promise<Response> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url.href}: HTTP ${r.status}`);
  return r;
}

async function main() {
  const { area } = await readCyclingConfig();
  const dir = cyclingPaths(area.id).osm;
  const base = new URL(`${cyclingOsmDataPath(area.id)}/`, CYCLING_OSM_FROM);
  const pointer = (await (
    await get(new URL(CYCLING_OSM_POINTER, base))
  ).json()) as CyclingOsmPointer;
  const local = await readCyclingOsm(dir);
  if (local?.pointer.sha256 === pointer.sha256) {
    log(`${area.id}: ${local.path} is the newest (${pointer.osmTimestamp})`);
    return;
  }
  const url = new URL(pointer.file, base);
  log(`${area.id}: downloading ${url.href} (${pointer.osmTimestamp})`);
  const bytes = Buffer.from(await (await get(url)).arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== pointer.sha256)
    throw new Error(
      `${url.href}: sha256 ${sha256}, expected ${pointer.sha256}`,
    );
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, pointer.file), bytes);
  await writeCyclingOsmPointer(dir, pointer, KEEP);
  log(`${area.id}: ${join(dir, pointer.file)}`);
}

await main();
