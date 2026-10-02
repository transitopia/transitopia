// Live dispatch (apps/server/README.md#live-dispatch-and-previews): one dispatcher per deployment, shared by every client.
//
// Every `dispatchCheckS` it reads the confirmed corrections (the database, or without one
// regions/metro-vancouver/observations/*.json and disruptions/*.json) and, for each service date near
// today whose inputs changed, re-dispatches that date and publishes a new patch version. Clients
// learn the current versions from /rt/live (or /rt/dispatch) and fetch
// /rt/dispatch/<date>/<version>.json, which never changes. Client requests never start a dispatch.
// Versions are kept in var/dispatch-history/<date>/<version>.json (and listed in dispatch_versions),
// so any version can be served again (and, later, an "as known then" view).
//
// Previews (docs/DESIGN.md#corrections-and-previews): an admin can dispatch a date with a correction that isn't confirmed
// yet. That's a version like any other, reachable by its link, but never current.

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import rtConfig from "@transitopia/region-metro-vancouver/config/rt.json" with { type: "json" };
import {
  DISPATCH_HISTORY_DIR,
  PUBLIC_DATA_DIR,
} from "@transitopia/pipelines/lib/paths.ts";
import { DispatchContexts } from "@transitopia/pipelines/lib/dispatch-context.ts";
import { datesOf } from "@transitopia/pipelines/lib/disruptions.ts";
import {
  activeDisruptions,
  dateVersion,
  dispatchDate,
  type DateInputs,
} from "@transitopia/transit-core/dispatch/date.ts";
import type {
  DispatchIndex,
  DispatchPatch,
} from "@transitopia/transit-core/dispatch/patch.ts";
import type { Observation } from "@transitopia/transit-core/corrections/types.ts";
import type { Disruption } from "@transitopia/transit-core/disruption/types.ts";
import { addDays, localDate } from "@transitopia/transit-core/time.ts";
import { FileCorrections, type Corrections } from "../corrections.ts";
import type { Store } from "../store.ts";

export interface LiveDispatchOptions {
  /** Where confirmed corrections come from (default: the files under regions/metro-vancouver). */
  corrections?: Corrections;
  observationsDir?: string;
  disruptionsDir?: string;
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
  private readonly contexts = new DispatchContexts();
  /** Service date → current patch version (dates without inputs have none: clients use the base plan). */
  private current = new Map<string, string>();
  private patches = new Map<string, DispatchPatch>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private checking: Promise<void> | undefined;
  private builtAt = 0;

  constructor(opts: LiveDispatchOptions = {}) {
    this.log = opts.log ?? ((m) => console.log(`[dispatch] ${m}`));
    this.corrections =
      opts.corrections
      ?? new FileCorrections({
        observationsDir: opts.observationsDir,
        disruptionsDir: opts.disruptionsDir,
        log: this.log,
      });
    this.store = opts.store;
    this.historyDir = opts.historyDir ?? DISPATCH_HISTORY_DIR;
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
        this.timer = setTimeout(tick, rtConfig.dispatchCheckS * 1000);
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
    return {
      schema: 1,
      byDate: Object.fromEntries(
        [...this.current]
          .sort()
          .map(([d, v]) => [
            d,
            { version: v, path: `rt/dispatch/${d}/${v}.json` },
          ]),
      ),
    };
  }

  /** A published patch version (from memory, or the history on disk). */
  async patch(
    date: string,
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
    const built = await stat(join(PUBLIC_DATA_DIR, "manifest.json")).then(
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
    const { observations, disruptions } = await this.corrections.load();
    const today = localDate(this.now());
    const lo = addDays(today, -rtConfig.dispatchWindowDays);
    const hi = addDays(today, rtConfig.dispatchWindowDays);
    const dates = new Set<string>();
    for (const o of observations) {
      const d = o.date.replaceAll("-", "");
      if (d >= lo && d <= hi) dates.add(d);
    }
    for (const d of disruptions)
      if (d.status !== "draft")
        for (const x of datesOf(d)) if (x >= lo && x <= hi) dates.add(x);
    // Dates whose inputs went away fall back to the base plan.
    for (const d of [...this.current.keys()])
      if (!dates.has(d)) this.current.delete(d);
    for (const date of [...dates].sort()) {
      const inputs: DateInputs = {
        date,
        observations: observations.filter(
          (o) => o.date.replaceAll("-", "") === date,
        ),
        disruptions,
      };
      const ctx = await this.contexts.forDate(date);
      if (!ctx) continue;
      if (!inputs.observations.length && !activeDisruptions(inputs).length)
        continue;
      const version = dateVersion(ctx, inputs);
      if (this.current.get(date) === version) continue;
      const existing = await this.patch(date, version);
      if (existing) {
        this.patches.set(`${date}/${version}`, existing);
        this.current.set(date, version);
        continue;
      }
      const t0 = performance.now();
      const patch = await this.publish(ctx, inputs, version, "live");
      this.patches.set(`${date}/${version}`, patch);
      this.current.set(date, version);
      this.log(
        `${date} → version ${version}: ${patch.summary.inputs.join(", ")} (${Math.round(performance.now() - t0)} ms)`,
      );
    }
    // Keep only current versions in memory; older ones are on disk.
    for (const key of [...this.patches.keys()]) {
      const [d, v] = key.split("/");
      if (this.current.get(d!) !== v) this.patches.delete(key);
    }
  }

  /** Dispatch a date and write the version (immutable) to the history. */
  private async publish(
    ctx: NonNullable<Awaited<ReturnType<DispatchContexts["forDate"]>>>,
    inputs: DateInputs,
    version: string,
    kind: "live" | "preview",
    previewOf?: string,
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
        date: inputs.date,
        version,
        kind,
        previewOf,
        inputs: patch.summary.inputs,
      })
      .catch((e: Error) => this.log(`could not list version (${e.message})`));
    return patch;
  }

  /**
   * Dispatch each date a candidate correction touches (within the live window) with the confirmed
   * corrections plus the candidate, as preview versions: date (YYYYMMDD) → version. Dates the
   * candidate doesn't change, or outside the window, are left out.
   */
  async preview(
    candidate: { observations?: Observation[]; disruptions?: Disruption[] },
    previewOf: string,
  ): Promise<
    Record<string, { version: string; summary: DispatchPatch["summary"] }>
  > {
    await this.refreshBase();
    const confirmed = await this.corrections.load();
    const dates = new Set<string>();
    for (const o of candidate.observations ?? [])
      dates.add(o.date.replaceAll("-", ""));
    for (const d of candidate.disruptions ?? [])
      for (const x of datesOf(d)) dates.add(x);
    const out: Record<
      string,
      { version: string; summary: DispatchPatch["summary"] }
    > = {};
    const ids = new Set((candidate.disruptions ?? []).map((d) => d.id));
    for (const date of [...dates].sort()) {
      const ctx = await this.contexts.forDate(date);
      if (!ctx) continue;
      const inputs: DateInputs = {
        date,
        observations: [
          ...confirmed.observations,
          ...(candidate.observations ?? []),
        ].filter((o) => o.date.replaceAll("-", "") === date),
        disruptions: [
          // The candidate replaces a confirmed disruption with the same id (an edit).
          ...confirmed.disruptions.filter((d) => !ids.has(d.id)),
          ...(candidate.disruptions ?? []).map((d) => ({
            ...d,
            status: "confirmed" as const,
          })),
        ],
      };
      const version = dateVersion(ctx, inputs);
      const patch =
        (await this.patch(date, version))
        ?? (await this.publish(ctx, inputs, version, "preview", previewOf));
      out[date] = { version, summary: patch.summary };
    }
    return out;
  }
}
