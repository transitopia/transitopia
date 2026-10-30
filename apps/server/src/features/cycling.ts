// The cycling map's OSM features for the feature resolver (apps/server/README.md#feature-resolver):
// the latest data build's lookup and bike routes (packages/cycling-core/README.md#lookup), read
// again when a build replaces them.

import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  findCyclingFeature,
  type CyclingFeature,
  type CyclingLookup,
} from "@transitopia/cycling-core/lookup.ts";
import {
  CYCLING_INDEX,
  type CyclingIndex,
  type CyclingRoutes,
} from "@transitopia/cycling-core/published.ts";
import {
  cyclingPaths,
  readCyclingConfig,
  readJson,
} from "@transitopia/data/paths.ts";

export type FindCyclingFeature = (
  key: string,
) => Promise<CyclingFeature | undefined>;

/** Finds cycling features in the files the data build wrote; nothing before the first build. */
export function cyclingFeatures(): FindCyclingFeature {
  let loaded:
    { at: number; lookup: CyclingLookup; routes: CyclingRoutes } | undefined;
  let loading: Promise<typeof loaded> | undefined;
  const load = async (): Promise<typeof loaded> => {
    const { area } = await readCyclingConfig();
    const paths = cyclingPaths(area.id);
    // The build writes the lookup before the index, so a newer index means both are in place.
    const indexPath = join(paths.out, CYCLING_INDEX);
    const at = await stat(indexPath).then(
      (s) => s.mtimeMs,
      () => undefined,
    );
    if (at === undefined) return undefined;
    if (loaded?.at === at) return loaded;
    const index = await readJson<CyclingIndex>(indexPath);
    return {
      at,
      lookup: await readJson<CyclingLookup>(paths.lookup),
      routes: await readJson<CyclingRoutes>(
        join(dirname(indexPath), index.routes),
      ),
    };
  };
  return async (key) => {
    loading ??= load()
      .catch((e: unknown) => {
        console.warn(`[features] reading the cycling lookup: ${String(e)}`);
        return loaded;
      })
      .finally(() => (loading = undefined));
    loaded = await loading;
    return loaded && findCyclingFeature(key, loaded.lookup, loaded.routes);
  };
}
