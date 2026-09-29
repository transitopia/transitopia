// Validate and publish observation files (PLAN.md §4.7):
//   data/observations/*.json → public/data/observations/<name>.json + index.json (by service date)
//
//   npm run build:observations

import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  OBSERVATIONS_DIR,
  PUBLIC_DATA_DIR,
  log,
  readJson,
  writeJson,
} from "./lib/paths.ts";
import type {
  Observation,
  ObservationFile,
  ObservationIndex,
} from "@transitopia/transit-core/corrections/types.ts";
import { observationProblems } from "@transitopia/transit-core/corrections/validate.ts";

const SRC = OBSERVATIONS_DIR;
const OUT = join(PUBLIC_DATA_DIR, "observations");
async function main() {
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
    for (const d of new Set(valid.map((o) => o.date.replaceAll("-", ""))))
      (index.byDate[d] ??= []).push(`data/observations/${f}`);
    count += valid.length;
  }
  await writeJson(join(OUT, "index.json"), index, true);
  log(
    `Published ${count} observations from ${files.length} files (${bad} invalid, skipped)`,
  );
  if (bad) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
