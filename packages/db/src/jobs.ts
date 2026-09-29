// Jobs on the leader: each run of a job is keyed (usually by service date) in job_runs, so a job
// runs once per key, a failed run is retried, and missed keys are caught up on startup. This covers
// Phase 2's handful of daily jobs without a queue library (V2-PLAN.md §4.3 suggested one; revisit
// when jobs need concurrency or fan-out).

import type { Db } from "./connect.ts";

export type JobStatus = "running" | "done" | "failed";

/** A run left "running" longer than this is assumed dead (the process stopped mid-run). */
const STALE_RUNNING_MS = 6 * 3_600_000;

/**
 * Run `fn` for (job, key) unless it's done (or running in a live process). Returns what happened.
 * A failure is recorded with its error and retried once `retryAfterMs` has passed.
 */
export async function runOnce(
  db: Db,
  job: string,
  key: string,
  fn: () => Promise<unknown>,
  opts: { retryAfterMs?: number; now?: () => Date } = {},
): Promise<"done" | "skipped" | "failed"> {
  const now = opts.now ?? (() => new Date());
  const retryAfterMs = opts.retryAfterMs ?? 3_600_000;
  const existing = await db
    .selectFrom("job_runs")
    .select(["status", "started_at", "finished_at"])
    .where("job", "=", job)
    .where("key", "=", key)
    .executeTakeFirst();
  if (existing?.status === "done") return "skipped";
  if (
    existing?.status === "running"
    && now().getTime() - existing.started_at.getTime() < STALE_RUNNING_MS
  )
    return "skipped";
  if (
    existing?.status === "failed"
    && existing.finished_at
    && now().getTime() - existing.finished_at.getTime() < retryAfterMs
  )
    return "skipped";
  await db
    .insertInto("job_runs")
    .values({
      job,
      key,
      status: "running",
      started_at: now(),
      finished_at: null,
      error: null,
      detail: null,
    })
    .onConflict((oc) =>
      oc.columns(["job", "key"]).doUpdateSet({
        status: "running",
        started_at: now(),
        finished_at: null,
        error: null,
      }),
    )
    .execute();
  try {
    const detail = await fn();
    await db
      .updateTable("job_runs")
      .set({
        status: "done",
        finished_at: now(),
        detail: detail === undefined ? null : JSON.stringify(detail),
      })
      .where("job", "=", job)
      .where("key", "=", key)
      .execute();
    return "done";
  } catch (e) {
    await db
      .updateTable("job_runs")
      .set({
        status: "failed",
        finished_at: now(),
        error: e instanceof Error ? (e.stack ?? e.message) : String(e),
      })
      .where("job", "=", job)
      .where("key", "=", key)
      .execute();
    return "failed";
  }
}

/** Latest runs per job, for /status and the admin page. */
export async function recentRuns(db: Db, limit = 50) {
  return db
    .selectFrom("job_runs")
    .selectAll()
    .orderBy("started_at", "desc")
    .limit(limit)
    .execute();
}
