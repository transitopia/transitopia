// Build a scenario (PLAN.md §4.8): alternate track and/or service defined in
// data/scenarios/<name>/scenario.json, run through the same pipeline as the base network:
// compose tracks → modify service → map platforms → infer runs → movements. Output:
//   public/data/scenarios/<name>/{manifest.json, plan.json, tracks.geojson, movements/}
// View with ?scenario=<name>.
//
//   npm run scenario -- <name>

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG_DIR, SCENARIOS_DIR, PUBLIC_DATA_DIR, log, readJson, writeJson } from './lib/paths.ts';
import { INFRA_DIR, loadLatestPlan, loadOverrides, loadTracks } from './lib/infra.ts';
import { buildAllMovements } from './lib/movements.ts';
import type { DispatchConfig } from '@transitopia/transit-core/dispatch/dispatch.ts';
import { TrackGraph } from '@transitopia/transit-core/infra/graph.ts';
import { mapPlatforms } from '@transitopia/transit-core/infra/platforms.ts';
import { routePattern } from '@transitopia/transit-core/infra/patterns.ts';
import type { InfraCollection } from '@transitopia/transit-core/infra/types.ts';
import { composeNetwork } from '@transitopia/transit-core/scenario/network.ts';
import { applyService } from '@transitopia/transit-core/scenario/service.ts';
import type { CustomTrackProps, ScenarioManifest, ScenarioSpec } from '@transitopia/transit-core/scenario/types.ts';
import type { OperationsConfig } from '@transitopia/transit-core/movement/build.ts';
import type { KinematicsConfig } from '@transitopia/transit-core/movement/kinematics.ts';

async function main() {
  const name = process.argv[2];
  if (!name || !/^[a-z0-9-]+$/.test(name)) throw new Error('Usage: npm run scenario -- <name> (lowercase, digits, dashes)');
  const dir = join(SCENARIOS_DIR, name);
  const spec = await readJson<ScenarioSpec>(join(dir, 'scenario.json'));
  const kin = await readJson<KinematicsConfig>(join(CONFIG_DIR, 'kinematics.json'));
  const ops = await readJson<OperationsConfig>(join(CONFIG_DIR, 'operations.json'));
  const overrides = await loadOverrides();
  const out = join(PUBLIC_DATA_DIR, 'scenarios', name);
  const rel = `data/scenarios/${name}`;

  // 1. Tracks.
  let tracks = await loadTracks();
  const infra = spec.infrastructure;
  if (infra) {
    const future = infra.includeFuture
      ? (JSON.parse(await readFile(join(INFRA_DIR, 'future.generated.geojson'), 'utf8')) as InfraCollection)
      : undefined;
    const custom = infra.customTrack
      ? (JSON.parse(await readFile(join(dir, infra.customTrack), 'utf8')) as GeoJSON.FeatureCollection<GeoJSON.LineString, CustomTrackProps>)
      : undefined;
    const composed = composeNetwork({ base: tracks, future, futureLines: infra.futureLines, custom, removeWays: infra.removeWays });
    tracks = composed.fc;
    log(`Tracks: ${JSON.stringify(composed.stats)}`);
  }
  const graph = TrackGraph.fromCollection(tracks);
  for (const t of overrides.turns.add) graph.setTurn(t.node, t.a, t.b, true);
  for (const t of overrides.turns.remove) graph.setTurn(t.node, t.a, t.b, false);

  // 2. Service.
  const base = await loadLatestPlan();
  const plan = spec.service?.operations.length ? applyService(base, spec.service.operations, kin, name) : { ...base, feedVersion: `${base.feedVersion}~${name}` };
  log(`Service: ${plan.trips.length} trips, ${plan.patterns.length} patterns`);

  // 3. Platforms and routing checks.
  const railKeys = new Set(plan.routes.filter((r) => r.kind === 'skytrain').map((r) => r.key));
  const report = mapPlatforms(graph, plan, railKeys, overrides.platforms, overrides.patternPlatforms);
  for (const b of report.breaks) log(`  warn: not routable without reversing: ${b}`);
  for (const t of report.turnbackFailures) log(`  warn: no turnback or yard from ${t}`);
  for (const u of report.unmapped) log(`  warn: platform not near any track: ${u}`);
  let failures = 0;
  for (const p of plan.patterns.filter((x) => railKeys.has(x.route))) failures += routePattern(graph, plan, report.assignments, p, report.patternPositions).failures.length;
  log(`Platforms: ${report.assignments.size} mapped; ${failures} unroutable hops`);

  // 4. Movements.
  const dispatchCfg = await readJson<DispatchConfig>(join(CONFIG_DIR, 'dispatch.json'));
  const { index } = await buildAllMovements({ plan, graph, platforms: report.assignments, patternPositions: report.patternPositions, kin, ops, dispatch: dispatchCfg, outDir: join(out, 'movements'), relDir: `${rel}/movements` });

  // 5. Publish.
  await writeJson(join(out, 'plan.json'), plan);
  await writeJson(join(out, 'tracks.geojson'), tracks);
  const manifest: ScenarioManifest = {
    schema: 1,
    name: spec.name,
    description: spec.description,
    builtAt: new Date().toISOString(),
    feeds: [{ version: plan.feedVersion, start: plan.feedStart, end: plan.feedEnd, path: `${rel}/plan.json`, builtAt: plan.builtAt, movements: `${rel}/movements/index.json` }],
    tracks: `${rel}/tracks.geojson`,
  };
  await writeJson(join(out, 'manifest.json'), manifest, true);
  log(`Scenario "${spec.name}" built: ${Object.keys(index.files).length} day types. View with ?scenario=${name}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
