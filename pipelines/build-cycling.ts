// Build the cycling tiles (packages/cycling-core/README.md) from the newest cycling OSM file in
// var/raw/osm-cycling/<area>/ (gzipped OPL with way node locations: pipelines/fetch-cycling-osm.ts
// fetches the published one, pipelines/extract-cycling-osm.ts makes one with osmium):
// packages/cycling-core classifies the ways and joins them into chains, and tippecanoe tiles them.
// Output: var/public/tiles/transitopia-cycling-<area>.pmtiles (served locally at /dev-data/tiles/).
// Needs tippecanoe 2.17 or later (TIPPECANOE names it if it isn't on the PATH).
//
//   tsx pipelines/build-cycling.ts [--opl <file.opl.gz>] [--out <file.pmtiles>]

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import { CyclingNetworkBuilder } from "@transitopia/cycling-core/network.ts";
import { parseOpl } from "@transitopia/cycling-core/osm.ts";
import {
  CYCLING_MAX_ZOOM,
  CYCLING_MIN_ZOOM,
  CYCLING_TILE_BUFFER,
  cyclingTileFeatures,
} from "@transitopia/cycling-core/tiles.ts";
import { readCyclingOsm } from "@transitopia/data/osm-extracts.ts";
import {
  cyclingPaths,
  log,
  readCyclingConfig,
} from "@transitopia/data/paths.ts";
import { tippecanoe } from "@transitopia/data/plan-tiles.ts";

/**
 * tippecanoe's options: every feature kept (short lines are held back by their minzoom instead), and
 * features with the same properties and no id (below the detail zoom) coalesced within a tile.
 */
const TILE_OPTIONS = [
  `--minimum-zoom=${CYCLING_MIN_ZOOM}`,
  `--maximum-zoom=${CYCLING_MAX_ZOOM}`,
  `--buffer=${CYCLING_TILE_BUFFER}`,
  "--drop-rate=1",
  "--coalesce",
  "--reorder",
  "--no-feature-limit",
  "--no-tile-size-limit",
  "--name=Transitopia Cycling",
  "--description=A vector map tileset with detailed cycling data.",
  '--attribution=<a href="https://www.transitopia.org/" target="_blank">&copy; Transitopia</a>',
];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const config = await readCyclingConfig();
  const paths = cyclingPaths(config.area.id);
  const opl = arg("--opl") ?? (await readCyclingOsm(paths.osm))?.path;
  if (!opl)
    throw new Error(
      `no cycling OSM file in ${paths.osm}: run pipelines/fetch-cycling-osm.ts (or extract-cycling-osm.ts)`,
    );
  const out = arg("--out") ?? paths.tiles;
  log(`cycling: ${opl}`);

  let t = Date.now();
  const builder = new CyclingNetworkBuilder(config.classify);
  const lines = createInterface({
    input: createReadStream(opl).pipe(createGunzip()),
  });
  for await (const line of lines) {
    const e = parseOpl(line);
    if (e) builder.add(e);
  }
  const network = builder.build();
  log(
    `cycling: ${network.ways.length} ways, ${network.parking.length} bike parking (${((Date.now() - t) / 1000).toFixed(0)} s)`,
  );

  t = Date.now();
  const features = cyclingTileFeatures(network.ways, network.parking);
  await tippecanoe(
    (function* () {
      for (const f of features) yield JSON.stringify(f);
    })(),
    out,
    TILE_OPTIONS,
  );
  log(
    `cycling: ${out}, ${((await stat(out)).size / 1e6).toFixed(1)} MB (${((Date.now() - t) / 1000).toFixed(0)} s)`,
  );
}

await main();
