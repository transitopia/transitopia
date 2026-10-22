// Service plans on disk, in their published form (packages/transit-core/DESIGN.md#published-plans):
// a core plan.json and the shape, corridor and trip files beside it. Pipelines and the server read
// and write whole ServicePlans through these; only the browser loads the parts one by one.

import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  assemblePlan,
  publishPlan,
  type PublishedPlan,
} from "@transitopia/transit-core/plan/published.ts";
import type { ServicePlan } from "@transitopia/transit-core/plan/types.ts";
import { readJson, writeJson } from "./paths.ts";

/**
 * A plan whole, from its plan.json and the files it names; with `trips: false`, without its trips
 * (each pattern keeps its start times), which is all drawing it needs.
 */
export async function readPlan(
  path: string,
  opts: { trips?: boolean } = {},
): Promise<ServicePlan> {
  const dir = dirname(path);
  return assemblePlan(
    await readJson<PublishedPlan>(path),
    (file) => readJson(join(dir, file)),
    opts,
  );
}

/** Only a plan's core (plan.json): routes, stops, patterns, calendar and what built it. */
export function readPlanCore(path: string): Promise<PublishedPlan> {
  return readJson<PublishedPlan>(path);
}

/**
 * Write a plan as plan.json and its parts beside it, replacing the files of an earlier build there
 * (its trip files may be for other services). plan.json goes last. Returns the bytes written.
 */
export async function writePlan(
  path: string,
  plan: ServicePlan,
): Promise<number> {
  const dir = dirname(path);
  const { core, files } = publishPlan(plan);
  for (const sub of ["trips", "paths"])
    await rm(join(dir, sub), { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  let bytes = 0;
  for (const [file, value] of files) {
    await writeJson(join(dir, file), value);
    bytes += (await stat(join(dir, file))).size;
  }
  await writeJson(path, core);
  return bytes + (await stat(path)).size;
}
