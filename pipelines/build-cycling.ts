// Build the cycling tiles (packages/cycling-core/README.md) from the newest OSM extract
// (pipelines/fetch-osm-extract.ts): osmium keeps the cycling ways, bike parking and bike routes and
// adds node locations to the ways; packages/cycling-core classifies the ways and joins them into
// chains; tippecanoe tiles them.
// Output: var/public/tiles/transitopia-cycling-<area>.pmtiles (served locally at /dev-data/tiles/).
// Needs osmium-tool and tippecanoe 2.17 or later (OSMIUM and TIPPECANOE name them if not on the PATH).
//
//   tsx pipelines/build-cycling.ts [--extract <file.osm.pbf>] [--out <file.pmtiles>]

import { createReadStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { OSM_FILTERS } from "@transitopia/cycling-core/classify.ts";
import { CyclingNetworkBuilder } from "@transitopia/cycling-core/network.ts";
import { parseOpl } from "@transitopia/cycling-core/osm.ts";
import {
  CYCLING_MAX_ZOOM,
  CYCLING_MIN_ZOOM,
  CYCLING_TILE_BUFFER,
  cyclingTileFeatures,
} from "@transitopia/cycling-core/tiles.ts";
import { listExtracts } from "@transitopia/data/osm-extracts.ts";
import { osmium } from "@transitopia/data/osmium.ts";
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
  const extract =
    arg("--extract") ?? (await listExtracts(config.area.id))[0]?.path;
  if (!extract)
    throw new Error(
      `no extract in ${paths.extracts}: run pipelines/fetch-osm-extract.ts`,
    );
  const out = arg("--out") ?? paths.tiles;
  log(`cycling: ${extract}`);

  // Intermediate files beside the extracts, removed afterwards.
  await mkdir(paths.extracts, { recursive: true });
  const tmp = join(paths.extracts, `cycling.${process.pid}.tmp`);
  const filtered = `${tmp}.osm.pbf`;
  const opl = `${tmp}.opl`;
  try {
    let t = Date.now();
    await osmium([
      "tags-filter",
      extract,
      ...OSM_FILTERS,
      "--overwrite",
      `--output=${filtered}`,
    ]);
    await osmium([
      "add-locations-to-ways",
      filtered,
      "--overwrite",
      "--output-format=opl,add_metadata=false",
      `--output=${opl}`,
    ]);
    log(
      `cycling: osmium kept ${((await stat(opl)).size / 1e6).toFixed(0)} MB of OPL (${((Date.now() - t) / 1000).toFixed(0)} s)`,
    );

    t = Date.now();
    const builder = new CyclingNetworkBuilder(config.classify);
    const lines = createInterface({ input: createReadStream(opl) });
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
  } finally {
    await rm(filtered, { force: true });
    await rm(opl, { force: true });
  }
}

await main();
