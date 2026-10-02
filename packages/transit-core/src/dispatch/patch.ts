// Dispatch patches (packages/transit-core/DESIGN.md#dispatcher): what one service date's inputs (observations, disruptions)
// change in its base plan. Built at build time for static hosting and by the RT service live, in
// the same format; clients apply the patch for the date they show.

import type { Observation } from "../corrections/types.ts";
import type { DispatchSummary, MovementsFile, Run } from "../movement/types.ts";
import type { ParkedTrain } from "../corrections/reconcile.ts";
import type { DisruptionNotice } from "../disruption/apply.ts";

export interface DispatchPatch {
  schema: 1;
  /** Service date, YYYYMMDD. */
  date: string;
  feedVersion: string;
  /** The base movement file's service key and build time (a patch only fits that base). */
  services: string[];
  baseBuiltAt: string;
  /** Content hash of the inputs; clients refetch when it changes. */
  version: string;
  builtAt: string;
  /** Runs that differ from the base plan (replace by id; new ids are added). */
  runs: Run[];
  /**
   * The whole day's plan instead of changed runs, when the inputs re-inferred it (disruptions
   * reroute and cancel trips, so runs and patterns change). Then `runs` is empty.
   */
  file?: MovementsFile;
  /** Disruptions in effect on the date, for display. */
  notices: DisruptionNotice[];
  parked: ParkedTrain[];
  summary: DispatchSummary;
  /** Observations that couldn't be applied, and why. */
  unmatched: { obs: Observation; reason: string }[];
  /** Disruption parts that couldn't be applied. */
  problems?: string[];
}

/** Published index of patches (var/public/data/dispatch/index.json, or the RT service's /rt/dispatch). */
export interface DispatchIndex {
  schema: 1;
  /** Service date (YYYYMMDD) → patch version and path (relative to the site root: data/… or rt/…). */
  byDate: Record<string, { version: string; path: string }>;
}

/** The runs of `dispatched` that differ from `base`, as a patch. */
export function makePatch(
  base: MovementsFile,
  dispatched: MovementsFile,
  meta: {
    date: string;
    version: string;
    builtAt: string;
    unmatched: DispatchPatch["unmatched"];
  },
): DispatchPatch {
  const baseRuns = new Map(base.runs.map((r) => [r.id, JSON.stringify(r)]));
  return {
    schema: 1,
    date: meta.date,
    feedVersion: dispatched.feedVersion,
    services: dispatched.services,
    baseBuiltAt: base.builtAt,
    version: meta.version,
    builtAt: meta.builtAt,
    runs: dispatched.runs.filter(
      (r) => baseRuns.get(r.id) !== JSON.stringify(r),
    ),
    notices: [],
    parked: dispatched.parked ?? [],
    summary: dispatched.dispatch!,
    unmatched: meta.unmatched,
  };
}

/** The date's plan: the base with the patch's runs swapped in (or the patch's own plan). */
export function applyPatch(
  base: MovementsFile,
  patch: DispatchPatch,
): MovementsFile {
  if (patch.file)
    return { ...patch.file, dispatch: patch.summary, parked: patch.parked };
  const replace = new Map(patch.runs.map((r) => [r.id, r]));
  const runs = base.runs.map((r) => replace.get(r.id) ?? r);
  for (const r of patch.runs)
    if (!base.runs.some((b) => b.id === r.id)) runs.push(r);
  return { ...base, runs, dispatch: patch.summary, parked: patch.parked };
}

/** Stable short hash of JSON-able inputs (FNV-1a), for patch versions. */
export function inputsVersion(value: unknown): string {
  // Keys sorted: the same inputs from files or from the database (jsonb reorders keys) hash the same.
  const s = JSON.stringify(value, (_, x: unknown) =>
    x && typeof x === "object" && !Array.isArray(x) ?
      Object.fromEntries(
        Object.entries(x).sort(([a], [b]) =>
          a < b ? -1
          : a > b ? 1
          : 0,
        ),
      )
    : x,
  );
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}
