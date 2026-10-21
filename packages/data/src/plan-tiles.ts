// Vector tiles of transit lines, made with tippecanoe (a recent build, 2.17 or later, for PMTiles
// output; `TIPPECANOE` names the binary when it isn't on the PATH): a plan's tiles
// (packages/transit-core/DESIGN.md#plan-tiles), named by a hash of their input so plans whose lines
// didn't change share them, and the overview tileset (pipelines/build-overview-tiles.ts).

import { createHash } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import {
  encodeRailPaths,
  type PublishedPlan,
} from "@transitopia/transit-core/plan/published.ts";
import { railPaths as railPathsOf } from "@transitopia/transit-core/plan/paths.ts";
import {
  PLAN_TILES_MAX_ZOOM,
  PLAN_TILES_MIN_ZOOM,
  planTileFeatures,
  type RailInput,
  type TileFeature,
} from "@transitopia/transit-core/plan/tiles.ts";
import type { ServicePlan } from "@transitopia/transit-core/plan/types.ts";
import { OVERVIEW_TILES_NAME } from "@transitopia/shared/transit-overview.ts";
import { run } from "./exec.ts";
import { PUBLIC_DIR, exists, readJson, writeJson } from "./paths.ts";

/** The overview tileset, as built (served locally at /dev-data/tiles/). */
export const OVERVIEW_TILES_FILE = join(
  PUBLIC_DIR,
  "tiles",
  `${OVERVIEW_TILES_NAME}.pmtiles`,
);

/** SkyTrain patterns' paths, beside the plan's core. */
const RAIL_PATHS = "rail-paths.json";
/** Hash characters in a plan tiles' name. */
const HASH_LENGTH = 16;

/**
 * Bump when the same features would be tiled differently (other tippecanoe options): the hash is
 * of this and the input, so plans get new tiles.
 */
const PLAN_TILES_FORMAT = 1;

/** tippecanoe's options for a plan's tiles: every feature kept at every zoom, ids and detail kept. */
const PLAN_TILE_OPTIONS = [
  `--minimum-zoom=${PLAN_TILES_MIN_ZOOM}`,
  `--maximum-zoom=${PLAN_TILES_MAX_ZOOM}`,
  // A missing corridor is a missing or wrongly coloured line: drop nothing to fit tile limits…
  "--drop-rate=1",
  "--no-feature-limit",
  "--no-tile-size-limit",
  // …and keep the last zoom (which the map overzooms) as detailed as the input.
  "--simplify-only-low-zooms",
  "--no-tiny-polygon-reduction",
];

/** Features as tippecanoe reads them (one per line), in an order of their own: the same features give the same text. */
export function tileInput(features: readonly TileFeature[]): string {
  return (
    features
      .map((f) => JSON.stringify(f))
      .sort()
      .join("\n") + "\n"
  );
}

/**
 * Make a plan's tiles in `dir` (unless they're there already) and name them in its plan.json, and
 * with `rail`, its SkyTrain patterns' paths over the line pieces they number (rail-paths.json,
 * `PlanFiles.railPaths`). Returns the tiles' path, relative to the plan's directory, and whether
 * they were made.
 */
export async function writePlanTiles(
  planPath: string,
  plan: ServicePlan,
  dir: string,
  rail?: RailInput,
): Promise<{ path: string; built: boolean }> {
  const input = tileInput(planTileFeatures(plan, rail));
  const hash = createHash("sha256")
    .update(`plan tiles ${PLAN_TILES_FORMAT}\n`)
    .update(input)
    .digest("hex")
    .slice(0, HASH_LENGTH);
  const file = join(dir, `${hash}.pmtiles`);
  const built = !(await exists(file));
  if (built) await tippecanoe(input, file, PLAN_TILE_OPTIONS);
  const path = relative(dirname(planPath), file).split("\\").join("/");
  const core = await readJson<PublishedPlan>(planPath);
  const railPaths = rail ? RAIL_PATHS : undefined;
  if (rail)
    await writeJson(
      join(dirname(planPath), RAIL_PATHS),
      encodeRailPaths(railPathsOf(plan, rail.lines)),
    );
  else await rm(join(dirname(planPath), RAIL_PATHS), { force: true });
  if (core.files.tiles !== path || core.files.railPaths !== railPaths) {
    core.files.tiles = path;
    if (railPaths) core.files.railPaths = railPaths;
    else delete core.files.railPaths;
    await writeJson(planPath, core);
  }
  return { path, built };
}

/** Tile newline-delimited GeoJSON features into a PMTiles file at `out` (written whole, then moved into place). */
export async function tippecanoe(
  input: string,
  out: string,
  options: string[],
): Promise<void> {
  await mkdir(dirname(out), { recursive: true });
  const tmp = `${out}.${process.pid}.tmp`;
  const src = `${tmp}.geojsonl`;
  const pmtiles = `${tmp}.pmtiles`;
  try {
    await writeFile(src, input);
    const cmd = process.env.TIPPECANOE || "tippecanoe";
    await run(cmd, [
      ...options,
      "--force",
      "--quiet",
      `--output=${pmtiles}`,
      src,
    ]).catch((e: NodeJS.ErrnoException) => {
      throw e.code === "ENOENT" ?
          new Error(
            `${cmd} not found: install tippecanoe 2.17 or later (brew install tippecanoe), or set TIPPECANOE`,
          )
        : e;
    });
    await rename(pmtiles, out);
  } finally {
    await rm(src, { force: true });
    await rm(pmtiles, { force: true });
  }
}
