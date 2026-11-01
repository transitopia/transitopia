// Validate and publish observation files (packages/transit-core/DESIGN.md#corrections):
//   config/feeds/<feed>/observations/*.json → var/public/data/feeds/<feed>/observations/<name>.json + index.json (by service date),
//   for each feed with track-level rail
//
//   npm run build:observations

import { isoToServiceDate } from "@transitopia/transit-core/time.ts";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  PUBLIC_DIR,
  log,
  correctionPaths,
  railNetworks,
  readJson,
  writeJson,
  type RailNetwork,
} from "@transitopia/data/paths.ts";
import type {
  Observation,
  ObservationFile,
  ObservationIndex,
} from "@transitopia/transit-core/corrections/types.ts";
import { observationProblems } from "@transitopia/transit-core/corrections/validate.ts";
import { feedDataPath } from "@transitopia/transit-core/plan/types.ts";

/** A rail feed's observations (railNetworks: whose dispatcher reads them). */
async function buildFeed(net: RailNetwork) {
  const SRC = correctionPaths(net).observations;
  const REL = feedDataPath(net.feed, undefined, "observations");
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
  const feeds = new Map((await railNetworks()).map((n) => [n.feed, n]));
  for (const net of feeds.values()) await buildFeed(net);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
