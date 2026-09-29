// Live dispatch (PLAN.md §4.11, M8.4): one dispatcher per deployment, shared by every client.
//
// Every `dispatchCheckS` it reads the inputs (data/observations/*.json, data/disruptions/*.json) and,
// for each service date near today whose inputs changed, re-dispatches that date and publishes a new
// patch version. Clients learn the current versions from /rt/live (or /rt/dispatch) and fetch
// /rt/dispatch/<date>/<version>.json, which never changes. Client requests never start a dispatch.
// Versions are kept in data/dispatch-history/<date>/<version>.json, so any version can be served
// again (and, later, an "as known then" view).

import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import rtConfig from '../../data/config/rt.json' with { type: 'json' };
import { ROOT, readJson } from '../../scripts/lib/paths.ts';
import { DispatchContexts } from '../../scripts/lib/dispatch-context.ts';
import { datesOf, loadDisruptions } from '../../scripts/lib/disruptions.ts';
import { activeDisruptions, dateVersion, dispatchDate, type DateInputs } from '../../src/core/dispatch/date.ts';
import type { DispatchIndex, DispatchPatch } from '../../src/core/dispatch/patch.ts';
import type { Observation, ObservationFile } from '../../src/core/corrections/types.ts';
import { observationProblems } from '../../src/core/corrections/validate.ts';
import { addDays, localDate } from '../../src/core/time.ts';

export interface LiveDispatchOptions {
  observationsDir?: string;
  disruptionsDir?: string;
  historyDir?: string;
  log?: (msg: string) => void;
  /** Override "now" (tests). */
  now?: () => number;
}

export class LiveDispatcher {
  private readonly observationsDir: string;
  private readonly disruptionsDir: string;
  readonly historyDir: string;
  private readonly log: (msg: string) => void;
  private readonly now: () => number;
  private readonly contexts = new DispatchContexts();
  /** Service date → current patch version (dates without inputs have none: clients use the base plan). */
  private current = new Map<string, string>();
  private patches = new Map<string, DispatchPatch>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private checking: Promise<void> | undefined;
  private builtAt = 0;

  constructor(opts: LiveDispatchOptions = {}) {
    this.observationsDir = opts.observationsDir ?? join(ROOT, 'data', 'observations');
    this.disruptionsDir = opts.disruptionsDir ?? join(ROOT, 'data', 'disruptions');
    this.historyDir = opts.historyDir ?? join(ROOT, 'data', 'dispatch-history');
    this.log = opts.log ?? ((m) => console.log(`[dispatch] ${m}`));
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const tick = async () => {
      await this.check().catch((e) => this.log(`check failed: ${(e as Error).message}`));
      if (this.running) this.timer = setTimeout(tick, rtConfig.dispatchCheckS * 1000);
    };
    void tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }

  /** Current versions, for /rt/live and /rt/dispatch. */
  pointer(): Record<string, string> {
    return Object.fromEntries([...this.current].sort());
  }

  index(): DispatchIndex {
    return { schema: 1, byDate: Object.fromEntries([...this.current].sort().map(([d, v]) => [d, { version: v, path: `rt/dispatch/${d}/${v}.json` }])) };
  }

  /** A published patch version (from memory, or the history on disk). */
  async patch(date: string, version: string): Promise<DispatchPatch | undefined> {
    if (!/^\d{8}$/.test(date) || !/^[0-9a-z]+$/.test(version)) return undefined;
    const hit = this.patches.get(`${date}/${version}`);
    if (hit) return hit;
    try {
      return JSON.parse(await readFile(join(this.historyDir, date, `${version}.json`), 'utf8')) as DispatchPatch;
    } catch {
      return undefined;
    }
  }

  /** Re-dispatch every date near today whose inputs changed (one check at a time). */
  check(): Promise<void> {
    this.checking ??= this.runCheck().finally(() => (this.checking = undefined));
    return this.checking;
  }

  private async runCheck(): Promise<void> {
    // A rebuild (npm run data / build:movements) replaces the base plans: start from the new ones.
    const built = await stat(join(ROOT, 'public', 'data', 'manifest.json')).then((s) => s.mtimeMs, () => 0);
    if (built !== this.builtAt) {
      this.builtAt = built;
      this.contexts.reset();
    }
    const [observations, disruptions] = await Promise.all([this.loadObservations(), loadDisruptions(this.disruptionsDir)]);
    const today = localDate(this.now());
    const lo = addDays(today, -rtConfig.dispatchWindowDays);
    const hi = addDays(today, rtConfig.dispatchWindowDays);
    const dates = new Set<string>();
    for (const o of observations) {
      const d = o.date.replaceAll('-', '');
      if (d >= lo && d <= hi) dates.add(d);
    }
    for (const d of disruptions) if (d.status !== 'draft') for (const x of datesOf(d)) if (x >= lo && x <= hi) dates.add(x);
    // Dates whose inputs went away fall back to the base plan.
    for (const d of [...this.current.keys()]) if (!dates.has(d)) this.current.delete(d);
    for (const date of [...dates].sort()) {
      const inputs: DateInputs = { date, observations: observations.filter((o) => o.date.replaceAll('-', '') === date), disruptions };
      const ctx = await this.contexts.forDate(date);
      if (!ctx) continue;
      if (!inputs.observations.length && !activeDisruptions(inputs).length) continue;
      const version = dateVersion(ctx, inputs);
      if (this.current.get(date) === version) continue;
      const existing = await this.patch(date, version);
      if (existing) {
        this.patches.set(`${date}/${version}`, existing);
        this.current.set(date, version);
        continue;
      }
      const t0 = performance.now();
      const patch = await dispatchDate(ctx, inputs, new Date(this.now()).toISOString());
      await mkdir(join(this.historyDir, date), { recursive: true });
      await writeFile(join(this.historyDir, date, `${version}.json`), JSON.stringify(patch));
      this.patches.set(`${date}/${version}`, patch);
      this.current.set(date, version);
      this.log(`${date} → version ${version}: ${patch.summary.inputs.join(', ')} (${Math.round(performance.now() - t0)} ms)`);
    }
    // Keep only current versions in memory; older ones are on disk.
    for (const key of [...this.patches.keys()]) {
      const [d, v] = key.split('/');
      if (this.current.get(d!) !== v) this.patches.delete(key);
    }
  }

  private async loadObservations(): Promise<Observation[]> {
    let files: string[] = [];
    try {
      files = (await readdir(this.observationsDir)).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
    const out: Observation[] = [];
    for (const f of files.sort()) {
      try {
        const file = await readJson<ObservationFile>(join(this.observationsDir, f));
        for (const o of file.observations) if (!observationProblems(o).length) out.push(o);
      } catch (e) {
        this.log(`skipping ${f}: ${(e as Error).message}`);
      }
    }
    return out;
  }
}
