// The leader's scheduled jobs (V2-PLAN.md §4.3–4.4). Every few minutes it runs whatever is due, one
// job at a time; job_runs makes each (job, key) run once and retries failures on the next tick, so
// missed days are caught up after downtime:
//
//   partitions:<UTC date>    create tomorrow's partitions
//   retention:<local date>   drop raw data older than the retention period (DB, files, archive)
//   daily:<service date>     observed stop times + route statistics, for each finished service date
//                            still within the retention period (catch-up included)
//   data:<local date>        build and publish the transit data (BUILD_DATA=1), at dataBuildAt
//   archive:<local hour>     copy closed recordings to the archive (ARCHIVE_REMOTE)

import { existsSync } from "node:fs";
import { join } from "node:path";
import recording from "@transitopia/region-metro-vancouver/config/recording.json" with { type: "json" };
import { PUBLIC_DATA_DIR } from "@transitopia/pipelines/lib/paths.ts";
import type { Db } from "@transitopia/db/connect.ts";
import { runOnce } from "@transitopia/db/jobs.ts";
import { ensurePartitions } from "@transitopia/db/partitions.ts";
import {
  addDays,
  localDate,
  serviceDayStart,
  toWallTime,
} from "@transitopia/transit-core/time.ts";
import type { CorrectionsRepo } from "../corrections.ts";
import type { ServerEnv } from "../env.ts";
import { archiveRecordings, expireRawData } from "./archive.ts";
import { dailyStats, hasRecording } from "./daily.ts";
import { buildData } from "./data-build.ts";

const TICK_MS = 5 * 60_000;
/** A daily job whose last success is older than this is reported unhealthy (h). */
const STALE_DAILY_H = 36;

export class Jobs {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private ticking: Promise<void> | undefined;
  private lastDataBuild: number | undefined;

  private readonly db: Db | undefined;
  private readonly regionId: string;
  private readonly repo: CorrectionsRepo | undefined;
  private readonly env: ServerEnv;
  private readonly log: (msg: string) => void;

  constructor(opts: {
    db: Db | undefined;
    regionId: string;
    repo: CorrectionsRepo | undefined;
    env: ServerEnv;
    log?: (msg: string) => void;
  }) {
    this.db = opts.db;
    this.regionId = opts.regionId;
    this.repo = opts.repo;
    this.env = opts.env;
    this.log = opts.log ?? ((m) => console.log(`[jobs] ${m}`));
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const loop = async () => {
      await this.tick().catch((e: Error) =>
        this.log(`tick failed: ${e.message}`),
      );
      if (this.running) this.timer = setTimeout(loop, TICK_MS);
    };
    void loop();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }

  tick(now = Date.now()): Promise<void> {
    this.ticking ??= this.runDue(now).finally(() => (this.ticking = undefined));
    return this.ticking;
  }

  /** Run a job unless done for this key; log only what ran. */
  private async job(
    name: string,
    key: string,
    fn: () => Promise<unknown>,
  ): Promise<void> {
    if (!this.db) {
      // Without a database there's no job_runs: run what's needed in memory, once per process.
      await fn();
      return;
    }
    const t0 = Date.now();
    const r = await runOnce(this.db, name, key, fn);
    if (r !== "skipped")
      this.log(
        `${name}:${key} ${r} (${Math.round((Date.now() - t0) / 1000)} s)`,
      );
  }

  private async runDue(now: number): Promise<void> {
    const db = this.db;
    const today = localDate(now);
    const wall = toWallTime(now);
    if (db) {
      await this.job(
        "partitions",
        new Date(now).toISOString().slice(0, 10),
        () => ensurePartitions(db, now),
      );
      await this.job("retention", today, () =>
        expireRawData({
          db,
          retentionDays: recording.retentionDays,
          archiveRemote: this.env.archiveRemote,
          now,
        }),
      );
    }
    // Build first when there's nothing to serve yet (a fresh server), else at the set time.
    if (this.env.buildData) {
      const [h, m] = recording.dataBuildAt.split(":").map(Number);
      const due = wall.hour * 60 + wall.minute >= h! * 60 + m!;
      const missing = !existsSync(join(PUBLIC_DATA_DIR, "manifest.json"));
      if (missing || due) {
        const key = missing && !due ? `${today}-initial` : today;
        if (
          !db
          && this.lastDataBuild
          && localDate(this.lastDataBuild) === today
          && !missing
        ) {
          // Built today already (no job_runs without a database).
        } else
          await this.job("data", key, async () => {
            const r = await buildData({
              db,
              regionId: this.regionId,
              repo: this.repo,
              env: this.env,
              log: this.log,
            });
            // The RT service and the dispatcher notice the new manifest themselves.
            this.lastDataBuild = Date.now();
            return r;
          });
      }
    }
    if (db) {
      // Every finished service date still within the raw data's lifetime, oldest first.
      for (let d = recording.retentionDays - 1; d >= 1; d--) {
        const date = addDays(today, -d);
        if (
          now
          < serviceDayStart(date) + recording.afterServiceDayH * 3_600_000
        )
          continue;
        if (!(await hasRecording(db, this.regionId, date))) continue;
        await this.job("daily", date, () =>
          dailyStats(db, this.regionId, date, this.log),
        );
      }
    }
    if (this.env.archiveRemote) {
      const remote = this.env.archiveRemote;
      await this.job(
        "archive",
        `${today}T${String(wall.hour).padStart(2, "0")}`,
        () => archiveRecordings(remote),
      );
    }
  }

  /** For /healthz: daily jobs that failed or haven't succeeded lately. */
  async health(): Promise<Record<string, { ok: boolean; detail?: string }>> {
    if (!this.db) return {};
    const out: Record<string, { ok: boolean; detail?: string }> = {};
    const rows = await this.db
      .selectFrom("job_runs")
      .select(["job", "key", "status", "finished_at", "error"])
      .where("started_at", ">", new Date(Date.now() - 3 * 86_400_000))
      .orderBy("started_at", "desc")
      .execute();
    for (const job of ["daily", ...(this.env.buildData ? ["data"] : [])]) {
      const mine = rows.filter((r) => r.job === job);
      const failed = mine.find((r) => r.status === "failed");
      const lastOk = mine.find((r) => r.status === "done")?.finished_at;
      // Nothing ran yet (a new server) isn't a failure; nothing succeeding for a while is.
      const stale =
        mine.length > 0
        && (!lastOk
          || Date.now() - lastOk.getTime() > STALE_DAILY_H * 3_600_000);
      out[`job:${job}`] = {
        ok: !failed && !stale,
        detail:
          failed ?
            `${job}:${failed.key} failed: ${(failed.error ?? "").split("\n")[0]}`
          : lastOk ? `last success ${lastOk.toISOString()}`
          : mine.length ? "no success in the last 3 days"
          : "no runs yet",
      };
    }
    return out;
  }
}
