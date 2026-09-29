// Disruption files (regions/metro-vancouver/disruptions/*.json): loading and the service dates they touch. Shared by
// build:dispatch and the RT service's live dispatch.

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { DISRUPTIONS_DIR, readJson } from "./paths.ts";
import type {
  Disruption,
  DisruptionFile,
} from "@transitopia/transit-core/disruption/types.ts";
import { periodsOn } from "@transitopia/transit-core/disruption/apply.ts";
import { addDays, localDate } from "@transitopia/transit-core/time.ts";

export { DISRUPTIONS_DIR };

/** Confirmed and draft disruptions from regions/metro-vancouver/disruptions/*.json. */
export async function loadDisruptions(
  dir = DISRUPTIONS_DIR,
): Promise<Disruption[]> {
  let files: string[] = [];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: Disruption[] = [];
  for (const f of files.sort())
    out.push(...(await readJson<DisruptionFile>(join(dir, f))).disruptions);
  return out;
}

/** Service dates (YYYYMMDD) a disruption touches. */
export function datesOf(d: Disruption): string[] {
  const dates = new Set<string>();
  for (const p of d.active) {
    for (const iso of [p.from, p.until]) {
      const local = localDate(Date.parse(iso));
      // The local date, and the day before (service after midnight belongs to it).
      for (const c of [addDays(local, -1), local])
        if (periodsOn(d, c).length) dates.add(c);
    }
  }
  return [...dates].sort();
}
