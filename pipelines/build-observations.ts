// Validate and publish observation files (packages/transit-core/DESIGN.md#corrections):
//   config/regions/<region>/observations/*.json → var/public/data/regions/<region>/observations/<name>.json + index.json (by service date),
//   for each region with track-level rail
//
//   npm run build:observations

import { isoToServiceDate } from "@transitopia/transit-core/time.ts";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  PUBLIC_DIR,
  log,
  railNetworks,
  regionPaths,
  readJson,
  writeJson,
} from "@transitopia/data/paths.ts";
import type {
  Observation,
  ObservationFile,
  ObservationIndex,
} from "@transitopia/transit-core/corrections/types.ts";
import { observationProblems } from "@transitopia/transit-core/corrections/validate.ts";
import { regionDataPath } from "@transitopia/transit-core/plan/types.ts";

async function buildRegion(region: string) {
  const SRC = regionPaths(region).observations;
  const REL = regionDataPath(region, "observations");
  const OUT = join(PUBLIC_DIR, REL);
  let files: string[] = [];
  try {
    files = (await readdir(SRC)).filter((f) => f.endsWith(".json"));
  } catch {
    // No observations directory.
  }
  await rm(OUT, { recursive: true, force: true });
  const index: ObservationIndex = { schema: 1, byDate: {} };
  let count = 0;
  let bad = 0;
  for (const f of files) {
    const data = await readJson<ObservationFile>(join(SRC, f));
    const valid: Observation[] = [];
    data.observations.forEach((o, i) => {
      const p = observationProblems(o);
      if (p.length) {
        bad++;
        log(`  ${f} #${i}: ${p.join("; ")}`);
      } else valid.push(o);
    });
    await writeJson(join(OUT, f), { observations: valid });
    for (const d of new Set(valid.map((o) => isoToServiceDate(o.date))))
      (index.byDate[d] ??= []).push(`${REL}/${f}`);
    count += valid.length;
  }
  await writeJson(join(OUT, "index.json"), index, true);
  log(
    `Published ${count} observations from ${files.length} files (${bad} invalid, skipped)`,
  );
  if (bad) process.exitCode = 1;
}

async function main() {
  const regions = new Set((await railNetworks()).map((n) => n.region));
  for (const region of regions) await buildRegion(region);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
