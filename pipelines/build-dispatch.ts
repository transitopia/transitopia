// Publish dispatch patches for dates with inputs (packages/transit-core/DESIGN.md#dispatcher): re-dispatch each date that has
// observations or disruptions and write what changed against its base plan.
//   var/public/data/regions/<rail region>/observations/*.json (from build:observations) + regions/metro-vancouver/disruptions/*.json
//     → var/public/data/regions/<rail region>/dispatch/<date>.json + index.json
//
//   npm run build:dispatch

import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  PUBLIC_DIR,
  RAIL_REGION,
  log,
  readJson,
  writeJson,
} from "@transitopia/data/paths.ts";
import { DispatchContexts } from "@transitopia/data/dispatch-context.ts";
import { dispatchDate } from "@transitopia/transit-core/dispatch/date.ts";
import type { DispatchIndex } from "@transitopia/transit-core/dispatch/patch.ts";
import type {
  Observation,
  ObservationFile,
  ObservationIndex,
} from "@transitopia/transit-core/corrections/types.ts";
import { datesOf, loadDisruptions } from "@transitopia/data/disruptions.ts";
import { regionDataPath } from "@transitopia/transit-core/plan/types.ts";

const OUT = join(PUBLIC_DIR, regionDataPath(RAIL_REGION, "dispatch"));

async function main() {
  const obsIndex = await readJson<ObservationIndex>(
    join(PUBLIC_DIR, regionDataPath(RAIL_REGION, "observations/index.json")),
  ).catch(() => ({ schema: 1, byDate: {} }) as ObservationIndex);
  const contexts = new DispatchContexts();
  await rm(OUT, { recursive: true, force: true });
  const index: DispatchIndex = { schema: 1, byDate: {} };
  const builtAt = new Date().toISOString();
  const disruptions = await loadDisruptions();
  const dates = new Set(Object.keys(obsIndex.byDate));
  for (const d of disruptions)
    if (d.status !== "draft") for (const x of datesOf(d)) dates.add(x);
  for (const date of [...dates].sort()) {
    const observations: Observation[] = [];
    for (const p of obsIndex.byDate[date] ?? [])
      observations.push(
        ...(await readJson<ObservationFile>(join(PUBLIC_DIR, p))).observations,
      );
    const ctx = await contexts.forDate(date);
    if (!ctx) {
      log(`${date}: no dispatched plan covers this date; skipped`);
      continue;
    }
    const t0 = performance.now();
    const patch = await dispatchDate(
      ctx,
      { date, observations, disruptions },
      builtAt,
    );
    const path = regionDataPath(RAIL_REGION, `dispatch/${date}.json`);
    await writeJson(join(PUBLIC_DIR, path), patch);
    index.byDate[date] = { version: patch.version, path };
    const changed =
      patch.file ?
        `whole day re-planned (${patch.file.runs.length} runs)`
      : `${patch.runs.length} runs changed`;
    log(
      `${date}: ${patch.summary.inputs.join(", ") || "no inputs"} → ${changed}; ${patch.summary.forced.length} forced; ${Math.round(performance.now() - t0)} ms`,
    );
    for (const u of patch.unmatched)
      log(
        `    not applied (${u.reason}): ${JSON.stringify(u.obs).slice(0, 160)}`,
      );
    for (const p of patch.problems ?? []) log(`    disruption problem: ${p}`);
  }
  await writeJson(join(OUT, "index.json"), index, true);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
