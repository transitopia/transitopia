// Loads what dispatching one service date needs from the built data (plan, graph, inferred and
// dispatched runs, config), with caching. Used by build:dispatch and the RT service.

import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG_DIR, PUBLIC_DIR, PUBLIC_DATA_DIR, readJson } from './paths.ts';
import { loadGraph } from './infra.ts';
import { preparePlan, type PreparedPlan } from '@transitopia/transit-core/schedule/engine.ts';
import { feedForDate, type FeedManifest, type ServicePlan } from '@transitopia/transit-core/plan/types.ts';
import { serviceKey, type MovementsFile, type MovementsIndex } from '@transitopia/transit-core/movement/types.ts';
import type { KinematicsConfig } from '@transitopia/transit-core/movement/kinematics.ts';
import type { OperationsConfig } from '@transitopia/transit-core/movement/build.ts';
import type { DispatchConfig } from '@transitopia/transit-core/dispatch/dispatch.ts';
import type { DateContext } from '@transitopia/transit-core/dispatch/date.ts';
import type { TrackGraph } from '@transitopia/transit-core/infra/graph.ts';
import { mapPlatforms, type PlatformReport } from '@transitopia/transit-core/infra/platforms.ts';
import type { Overrides } from './infra.ts';

export class DispatchContexts {
  private manifest: Promise<FeedManifest> | undefined;
  private graph: Promise<{ graph: TrackGraph; overrides: Overrides }> | undefined;
  private platforms = new Map<string, PlatformReport>();
  private configs: Promise<{ kin: KinematicsConfig; ops: OperationsConfig; dispatch: DispatchConfig }> | undefined;
  private plans = new Map<string, Promise<PreparedPlan>>();
  private files = new Map<string, Promise<MovementsFile>>();

  /** Forget cached build outputs (after a rebuild). */
  reset(): void {
    this.manifest = undefined;
    this.plans.clear();
    this.files.clear();
  }

  private loadConfigs() {
    return (this.configs ??= Promise.all([
      readJson<KinematicsConfig>(join(CONFIG_DIR, 'kinematics.json')),
      readJson<OperationsConfig>(join(CONFIG_DIR, 'operations.json')),
      readJson<DispatchConfig>(join(CONFIG_DIR, 'dispatch.json')),
    ]).then(([kin, ops, dispatch]) => ({ kin, ops, dispatch })));
  }

  /** A built movement file, re-read when it changes on disk (a rebuild while the service runs). */
  private async file(path: string): Promise<MovementsFile> {
    const abs = join(PUBLIC_DIR, path);
    const key = `${path}|${(await stat(abs)).mtimeMs}`;
    let f = this.files.get(key);
    if (!f) {
      for (const k of this.files.keys()) if (k.startsWith(`${path}|`)) this.files.delete(k);
      this.files.set(key, (f = readJson<MovementsFile>(abs)));
    }
    return f;
  }

  /** The context for a service date (YYYYMMDD), or undefined if no dispatched plan covers it. */
  async forDate(date: string): Promise<DateContext | undefined> {
    const manifest = await (this.manifest ??= readJson<FeedManifest>(join(PUBLIC_DATA_DIR, 'manifest.json')));
    const feed = feedForDate(manifest, date);
    if (!feed) return undefined;
    const { kin, ops, dispatch } = await this.loadConfigs();
    let ppP = this.plans.get(feed.version);
    if (!ppP) this.plans.set(feed.version, (ppP = readJson<ServicePlan>(join(PUBLIC_DIR, feed.path)).then((p) => preparePlan(p, kin))));
    const pp = await ppP;
    const index = await readJson<MovementsIndex>(join(PUBLIC_DIR, feed.movements ?? `data/feeds/${feed.version}/movements/index.json`));
    const rail = new Set(pp.plan.trips.filter((t) => pp.routes.get(pp.plan.patterns[t.pattern]!.route)?.kind === 'skytrain').map((t) => t.service));
    const key = serviceKey([...pp.servicesOn(date)].filter((s) => rail.has(s)));
    const path = index.files[key];
    if (!path) return undefined;
    const [base, inferred, { graph, overrides }] = await Promise.all([
      this.file(path),
      this.file(path.replace(/\/([^/]+)$/, '/inferred/$1')),
      (this.graph ??= loadGraph()),
    ]);
    if (base.schema !== 2) return undefined;
    let report = this.platforms.get(feed.version);
    if (!report) {
      const railKeys = new Set(pp.plan.routes.filter((r) => r.kind === 'skytrain').map((r) => r.key));
      this.platforms.set(feed.version, (report = mapPlatforms(graph, pp.plan, railKeys, overrides.platforms, overrides.patternPlatforms)));
    }
    return { pp, graph, inferred, base, config: dispatch, kin, ops, platforms: report.assignments, ...(report.patternPositions ? { patternPositions: report.patternPositions } : {}) };
  }
}
