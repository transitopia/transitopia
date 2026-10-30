// Build the cycling tiles and bike routes (packages/cycling-core/README.md#published-files) from the
// newest cycling OSM file in var/raw/osm-cycling/<area>/ (gzipped OPL with way node locations:
// pipelines/fetch-cycling-osm.ts fetches the published one, pipelines/extract-cycling-osm.ts makes
// one with osmium): packages/cycling-core classifies the ways and joins them into chains, and
// tippecanoe tiles them. Files are named by their content; index.json names the current ones, and
// files it no longer names are removed (the published copies stay for clients holding an older index).
// Output: var/public/data/cycling/<area>/{index.json, tiles/<hash>.pmtiles, routes/<hash>.json}, and
// var/cycling/<area>/lookup.json for the server's feature resolver (not published).
// Needs tippecanoe 2.17 or later (TIPPECANOE names it if it isn't on the PATH).
//
//   tsx pipelines/build-cycling.ts

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, rename, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import { cyclingLookup } from "@transitopia/cycling-core/lookup.ts";
import { CyclingNetworkBuilder } from "@transitopia/cycling-core/network.ts";
import { parseOpl } from "@transitopia/cycling-core/osm.ts";
import {
  CYCLING_INDEX,
  type CyclingIndex,
  type CyclingRoutes,
} from "@transitopia/cycling-core/published.ts";
import {
  CYCLING_MAX_ZOOM,
  CYCLING_MIN_ZOOM,
  CYCLING_TILE_BUFFER,
  cyclingTileFeatures,
  detailChains,
} from "@transitopia/cycling-core/tiles.ts";
import { readCyclingOsm } from "@transitopia/data/osm-extracts.ts";
import {
  cyclingPaths,
  log,
  readCyclingConfig,
  writeJson,
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

/** Hash characters in a file's name. */
const HASH_LENGTH = 16;

/**
 * Bump when the same features would be tiled differently (other tippecanoe options): the tiles'
 * name is a hash of this and their input (tippecanoe's output isn't the same twice: it names its
 * temporary input file in the tiles' metadata).
 */
const TILES_FORMAT = 1;

const hashOf = (data: string) =>
  createHash("sha256").update(data).digest("hex").slice(0, HASH_LENGTH);

/** Remove the files in `dir` other than `keep`. */
async function prune(dir: string, keep: string): Promise<void> {
  for (const f of await readdir(dir))
    if (f !== keep) await rm(join(dir, f), { force: true });
}

async function main() {
  const config = await readCyclingConfig();
  const paths = cyclingPaths(config.area.id);
  const osm = await readCyclingOsm(paths.osm);
  if (!osm)
    throw new Error(
      `no cycling OSM file in ${paths.osm}: run pipelines/fetch-cycling-osm.ts (or extract-cycling-osm.ts)`,
    );
  log(`cycling: ${osm.path}`);

  let t = Date.now();
  const builder = new CyclingNetworkBuilder(config.classify);
  const lines = createInterface({
    input: createReadStream(osm.path).pipe(createGunzip()),
  });
  for await (const line of lines) {
    const e = parseOpl(line);
    if (e) builder.add(e);
  }
  const network = builder.build();
  log(
    `cycling: ${network.ways.length} ways, ${network.parking.length} bike parking, ${network.routes.size} bike routes (${((Date.now() - t) / 1000).toFixed(0)} s)`,
  );

  t = Date.now();
  const tilesDir = join(paths.out, "tiles");
  const built = join(tilesDir, `build.${process.pid}.pmtiles`);
  const chains = detailChains(network.ways);
  const features = cyclingTileFeatures(network.ways, network.parking, chains);
  const hash = createHash("sha256").update(`cycling tiles ${TILES_FORMAT}\n`);
  await tippecanoe(
    (function* () {
      for (const f of features) {
        const line = JSON.stringify(f);
        hash.update(`${line}\n`);
        yield line;
      }
    })(),
    built,
    TILE_OPTIONS,
  );
  const tiles = `${hash.digest("hex").slice(0, HASH_LENGTH)}.pmtiles`;
  await rename(built, join(tilesDir, tiles));
  await prune(tilesDir, tiles);
  log(
    `cycling: tiles/${tiles}, ${((await stat(join(tilesDir, tiles))).size / 1e6).toFixed(1)} MB (${((Date.now() - t) / 1000).toFixed(0)} s)`,
  );

  const routesDir = join(paths.out, "routes");
  const data: CyclingRoutes = Object.fromEntries(network.routes);
  const routes = `${hashOf(JSON.stringify(data))}.json`;
  await writeJson(join(routesDir, routes), data);
  await prune(routesDir, routes);

  // Before the index, so the resolver never knows less than the published tiles.
  await writeJson(paths.lookup, cyclingLookup(chains, network.parking));

  const index: CyclingIndex = {
    tiles: `tiles/${tiles}`,
    routes: `routes/${routes}`,
    osm: { file: basename(osm.path), timestamp: osm.pointer.osmTimestamp },
    builtAt: new Date().toISOString(),
  };
  await writeJson(join(paths.out, CYCLING_INDEX), index, true);
  log(`cycling: ${join(paths.out, CYCLING_INDEX)}`);
}

await main();
