// Dispatch patches (PLAN.md §4.11): what one service date's inputs (observations, disruptions)
// change in its base plan. Built at build time for static hosting and by the RT service live, in
// the same format; clients apply the patch for the date they show.

import type { Observation } from '../corrections/types.ts';
import type { DispatchSummary, MovementsFile, Run } from '../movement/types.ts';
import type { ParkedTrain } from '../corrections/reconcile.ts';

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
  parked: ParkedTrain[];
  summary: DispatchSummary;
  /** Inputs that couldn't be applied, and why. */
  unmatched: { obs: Observation; reason: string }[];
}

/** Published index of patches (public/data/dispatch/index.json, or the RT service's /rt/dispatch). */
export interface DispatchIndex {
  schema: 1;
  /** Service date (YYYYMMDD) → patch version and path (relative to public/, or a /rt/ URL). */
  byDate: Record<string, { version: string; path: string }>;
}

/** The runs of `dispatched` that differ from `base`, as a patch. */
export function makePatch(
  base: MovementsFile,
  dispatched: MovementsFile,
  meta: { date: string; version: string; builtAt: string; unmatched: DispatchPatch['unmatched'] },
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
    runs: dispatched.runs.filter((r) => baseRuns.get(r.id) !== JSON.stringify(r)),
    parked: dispatched.parked ?? [],
    summary: dispatched.dispatch!,
    unmatched: meta.unmatched,
  };
}

/** The date's plan: the base with the patch's runs swapped in. */
export function applyPatch(base: MovementsFile, patch: DispatchPatch): MovementsFile {
  const replace = new Map(patch.runs.map((r) => [r.id, r]));
  const runs = base.runs.map((r) => replace.get(r.id) ?? r);
  for (const r of patch.runs) if (!base.runs.some((b) => b.id === r.id)) runs.push(r);
  return { ...base, runs, dispatch: patch.summary, parked: patch.parked };
}

/** Stable short hash of JSON-able inputs (FNV-1a), for patch versions. */
export function inputsVersion(value: unknown): string {
  const s = JSON.stringify(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}
