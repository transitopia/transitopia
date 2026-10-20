// Shared loaders for scripts: a region's track graph (with overrides) and a feed's built service plans.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PUBLIC_DIR, readJson, readManifest, regionPaths } from "./paths.ts";
import { readPlan } from "./plans.ts";
import { TrackGraph } from "@transitopia/transit-core/infra/graph.ts";
import type { InfraCollection } from "@transitopia/transit-core/infra/types.ts";
import type {
  PatternPlatformRule,
  PlatformOverride,
} from "@transitopia/transit-core/infra/platforms.ts";
import type { ServicePlan } from "@transitopia/transit-core/plan/types.ts";
import type { LonLat } from "@transitopia/transit-core/geo.ts";

export interface TurnOverride {
  node: LonLat;
  a: LonLat;
  b: LonLat;
  note?: string;
}

export interface Overrides {
  osm: { includeWays: number[]; excludeWays: number[] };
  /** GeoJSON file (in the region's infrastructure/) of track missing from OSM, joined by coordinates. */
  addTrack?: string;
  turns: { add: TurnOverride[]; remove: TurnOverride[] };
  platforms: PlatformOverride[];
  /** Role-based platform pins (see PatternPlatformRule). */
  patternPlatforms?: PatternPlatformRule[];
}

export async function loadOverrides(region: string): Promise<Overrides> {
  return readJson<Overrides>(join(regionPaths(region).infra, "overrides.json"));
}

export async function loadTracks(region: string): Promise<InfraCollection> {
  return JSON.parse(
    await readFile(
      join(regionPaths(region).infra, "tracks.generated.geojson"),
      "utf8",
    ),
  ) as InfraCollection;
}

export async function loadGraph(region: string): Promise<{
  graph: TrackGraph;
  overrides: Overrides;
  tracks: InfraCollection;
}> {
  const [tracks, overrides] = await Promise.all([
    loadTracks(region),
    loadOverrides(region),
  ]);
  const graph = TrackGraph.fromCollection(tracks);
  for (const t of overrides.turns.add) graph.setTurn(t.node, t.a, t.b, true);
  for (const t of overrides.turns.remove)
    graph.setTurn(t.node, t.a, t.b, false);
  return { graph, overrides, tracks };
}

/** A feed's newest built plan (the version covering the latest dates). */
export async function loadLatestPlan(feed: string): Promise<ServicePlan> {
  const manifest = await readManifest(feed);
  const latest = [...manifest.feeds].sort((a, b) =>
    a.start < b.start ? 1 : -1,
  )[0];
  if (!latest) throw new Error(`No built ${feed} plans; run npm run data:gtfs`);
  return readPlan(join(PUBLIC_DIR, latest.path));
}

/** Every built version of a feed's plan. */
export async function loadAllPlans(feed: string): Promise<ServicePlan[]> {
  const manifest = await readManifest(feed);
  return Promise.all(
    manifest.feeds.map((f) => readPlan(join(PUBLIC_DIR, f.path))),
  );
}
