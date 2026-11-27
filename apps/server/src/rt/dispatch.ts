// Live dispatch (apps/server/README.md#live-dispatch): one dispatcher per deployment, shared by every client.
//
// Every `dispatchCheckS` it reads the corrections (from the database) and, for each service date near
// today whose inputs changed, re-dispatches that date and publishes a new patch version. Clients
// learn the current versions from the network's live endpoint (/networks/<id>/live/dispatch, or the index at /networks/<id>/dispatch) and fetch
// /networks/<id>/dispatch/<date>/<version>.json, which never changes. Client requests never start a dispatch.
// Versions are kept in var/dispatch-history/<network>/<date>/<version>.json (and listed in dispatch_versions),
// so any version can be served again (and, later, an "as known then" view).

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { serverConfig } from "../config.ts";
import {
  DISPATCH_HISTORY_DIR,
  feedPaths,
  type RailNetwork,
} from "@transitopia/data/paths.ts";
import { DispatchContexts } from "@transitopia/data/dispatch-context.ts";
import {
  dateVersion,
  dispatchDate,
  type DateInputs,
} from "@transitopia/transit-core/dispatch/date.ts";
import type {
  DispatchIndex,
  DispatchPatch,
} from "@transitopia/transit-core/dispatch/patch.ts";
import {
  addDays,
  localDate,
  type ServiceDate,
  isoToServiceDate,
} from "@transitopia/transit-core/time.ts";
import type { Corrections } from "../corrections.ts";
import type { Store } from "../store.ts";

export interface LiveDispatchOptions {
  /** The rail network it dispatches (packages/data/src/paths.ts → railNetwork). */
  net: RailNetwork;
  /** Where corrections come from (the database: CorrectionsRepo). */
  corrections: Corrections;
  /** Where its versions are kept (default: var/dispatch-history/<network>/). */
  historyDir?: string;
  /** Lists published versions in the database. */
  store?: Store;
  log?: (msg: string) => void;
  /** Override "now" (tests). */
  now?: () => number;
}

export class LiveDispatcher {
  private readonly corrections: Corrections;
  private readonly store: Store | undefined;
  readonly historyDir: string;
  private readonly log: (msg: string) => void;
  private readonly now: () => number;
  private readonly contexts: DispatchContexts;
  /** The rail network it dispatches (network.json → id). */
  readonly network: string;
  /** Service date → current patch version (dates without inputs have none: clients use the base plan). */
  private current = new Map<ServiceDate, string>();
  /** By "<date>/<version>". */
  private patches = new Map<string, DispatchPatch>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private checking: Promise<void> | undefined;
  private builtAt = 0;

  constructor(opts: LiveDispatchOptions) {
    this.log = opts.log ?? ((m) => console.log(`[dispatch] ${m}`));
    this.contexts = new DispatchContexts(opts.net);
    this.network = opts.net.network;
    this.corrections = opts.corrections;
    this.store = opts.store;
    this.historyDir =
      opts.historyDir ?? join(DISPATCH_HISTORY_DIR, opts.net.network);
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const tick = async () => {
      await this.check().catch((e) =>
        this.log(`check failed: ${(e as Error).message}`),
      );
      if (this.running)
        this.timer = setTimeout(tick, serverConfig.dispatchCheckS * 1000);
    };
    void tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }

  /** Current versions, for the live endpoints and /networks/<id>/dispatch. */
  pointer(): Record<string, string> {
    return Object.fromEntries(
      [...this.current].sort(([a], [b]) => a.localeCompare(b)),
    );
  }

  /** The index of current versions, with their paths under the RT service (/networks/<id>/dispatch/…). */
  index(): DispatchIndex {
    return {
      schema: 1,
      byDate: Object.fromEntries(
        [...this.current]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([d, v]) => [
            d,
            {
              version: v,
              path: `networks/${this.network}/dispatch/${d}/${v}.json`,
            },
          ]),
      ),
    };
  }

  /** A published patch version (from memory, or the history on disk). */
  async patch(
    date: ServiceDate,
    version: string,
  ): Promise<DispatchPatch | undefined> {
    if (!/^\d{8}$/.test(date) || !/^[0-9a-z]+$/.test(version)) return undefined;
    const hit = this.patches.get(`${date}/${version}`);
    if (hit) return hit;
    try {
      return JSON.parse(
        await readFile(join(this.historyDir, date, `${version}.json`), "utf8"),
      ) as DispatchPatch;
    } catch {
      return undefined;
    }
  }

  /** Re-dispatch every date near today whose inputs changed (one check at a time). */
  check(): Promise<void> {
    this.checking ??= this.runCheck().finally(
      () => (this.checking = undefined),
    );
    return this.checking;
  }

  /** A rebuild (npm run data / build:movements) replaces the base plans: start from the new ones. */
  private async refreshBase(): Promise<void> {
    // The rail feed's manifest, which every build rewrites (or writes for the first time).
    const built = await stat(feedPaths(this.contexts.net.feed).manifest).then(
      (s) => s.mtimeMs,
      () => 0,
    );
    if (built !== this.builtAt) {
      this.builtAt = built;
      this.contexts.reset();
    }
  }

  private async runCheck(): Promise<void> {
    await this.refreshBase();
    const { observations } = await this.corrections.load();
    const today = localDate(this.now());
    const lo = addDays(today, -serverConfig.dispatchWindowDays);
    const hi = addDays(today, serverConfig.dispatchWindowDays);
    const dates = new Set<ServiceDate>();
    for (const o of observations) {
      const d = isoToServiceDate(o.date);
      if (d >= lo && d <= hi) dates.add(d);
    }
    // Dates whose inputs went away fall back to the base plan.
    for (const d of this.current.keys())
      if (!dates.has(d)) this.current.delete(d);
    for (const date of [...dates].sort((a, b) => a.localeCompare(b))) {
      const inputs: DateInputs = {
        date,
        observations: observations.filter(
          (o) => isoToServiceDate(o.date) === date,
        ),
      };
      const ctx = await this.contexts.forDate(date);
      if (!ctx) continue;
      const version = dateVersion(ctx, inputs);
      if (this.current.get(date) === version) continue;
      const existing = await this.patch(date, version);
      if (existing) {
        this.patches.set(`${date}/${version}`, existing);
        this.current.set(date, version);
        continue;
      }
      const t0 = performance.now();
      const patch = await this.publish(ctx, inputs, version);
      this.patches.set(`${date}/${version}`, patch);
      this.current.set(date, version);
      this.log(
        `${date} → version ${version}: ${patch.summary.inputs.join(", ")} (${Math.round(performance.now() - t0)} ms)`,
      );
    }
    // Keep only current versions in memory; older ones are on disk.
    for (const [key, p] of this.patches)
      if (this.current.get(p.date) !== p.version) this.patches.delete(key);
  }

  /** Dispatch a date and write the version (immutable) to the history. */
  private async publish(
    ctx: NonNullable<Awaited<ReturnType<DispatchContexts["forDate"]>>>,
    inputs: DateInputs,
    version: string,
  ): Promise<DispatchPatch> {
    const patch = await dispatchDate(
      ctx,
      inputs,
      new Date(this.now()).toISOString(),
    );
    await mkdir(join(this.historyDir, inputs.date), { recursive: true });
    await writeFile(
      join(this.historyDir, inputs.date, `${version}.json`),
      JSON.stringify(patch),
    );
    await this.store
      ?.recordDispatchVersion({
        network: this.network,
        date: inputs.date,
        version,
        inputs: patch.summary.inputs,
      })
      .catch((e: Error) => this.log(`could not list version (${e.message})`));
    return patch;
  }
}
