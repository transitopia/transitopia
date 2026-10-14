// Shared loaders for scripts: the track graph (with overrides) and the newest built service plan.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  INFRA_DIR,
  PUBLIC_DIR,
  RAIL_FEED,
  readJson,
  readManifest,
} from "./paths.ts";
import { TrackGraph } from "@transitopia/transit-core/infra/graph.ts";
import type { InfraCollection } from "@transitopia/transit-core/infra/types.ts";
import type {
  PatternPlatformRule,
  PlatformOverride,
} from "@transitopia/transit-core/infra/platforms.ts";
import type { ServicePlan } from "@transitopia/transit-core/plan/types.ts";
import type { LonLat } from "@transitopia/transit-core/geo.ts";

export { INFRA_DIR };

export interface TurnOverride {
  node: LonLat;
  a: LonLat;
  b: LonLat;
  note?: string;
}

export interface Overrides {
  osm: { includeWays: number[]; excludeWays: number[] };
  /** GeoJSON file (in regions/metro-vancouver/infrastructure/) of track missing from OSM, joined by coordinates. */
  addTrack?: string;
  turns: { add: TurnOverride[]; remove: TurnOverride[] };
  platforms: PlatformOverride[];
  /** Role-based platform pins (see PatternPlatformRule). */
  patternPlatforms?: PatternPlatformRule[];
}

export async function loadOverrides(): Promise<Overrides> {
  return readJson<Overrides>(join(INFRA_DIR, "overrides.json"));
}

export async function loadTracks(): Promise<InfraCollection> {
  return JSON.parse(
    await readFile(join(INFRA_DIR, "tracks.generated.geojson"), "utf8"),
  ) as InfraCollection;
}

export async function loadGraph(): Promise<{
  graph: TrackGraph;
  overrides: Overrides;
  tracks: InfraCollection;
}> {
  const [tracks, overrides] = await Promise.all([
    loadTracks(),
    loadOverrides(),
  ]);
  const graph = TrackGraph.fromCollection(tracks);
  for (const t of overrides.turns.add) graph.setTurn(t.node, t.a, t.b, true);
  for (const t of overrides.turns.remove)
    graph.setTurn(t.node, t.a, t.b, false);
  return { graph, overrides, tracks };
}

/** The rail feed's newest built plan (the version covering the latest dates). */
export async function loadLatestPlan(): Promise<ServicePlan> {
  const manifest = await readManifest(RAIL_FEED);
  const feed = [...manifest.feeds].sort((a, b) =>
    a.start < b.start ? 1 : -1,
  )[0];
  if (!feed) throw new Error("No built feeds; run npm run data:gtfs");
  return readJson<ServicePlan>(join(PUBLIC_DIR, feed.path));
}

/** Every built version of a feed's plan (default: the rail feed's). */
export async function loadAllPlans(feed = RAIL_FEED): Promise<ServicePlan[]> {
  const manifest = await readManifest(feed);
  return Promise.all(
    manifest.feeds.map((f) => readJson<ServicePlan>(join(PUBLIC_DIR, f.path))),
  );
}
