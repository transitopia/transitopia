// The leader's scheduled jobs (apps/server/README.md#jobs). Every few minutes it runs whatever is due, one
// job at a time; job_runs makes each (job, key) run once and retries failures on the next tick, so
// missed days are caught up after downtime:
//
//   partitions:<UTC date>    create tomorrow's partitions
//   retention:<local date>   drop raw data older than the retention period (DB, files, archive)
//   daily:<feed>:<service date>   a feed's observed stop times + route statistics, for each finished
//                            service date still within the retention period (catch-up included)
//   data:<local date>        build and publish the transit data (BUILD_DATA=1), at dataBuildAt
//   archive:<local hour>     copy closed recordings to the archive (ARCHIVE_REMOTE)

import { existsSync } from "node:fs";
import { recordingConfig as recording } from "../config.ts";
import { feedPaths } from "@transitopia/data/paths.ts";
import type { FeedInfo } from "@transitopia/transit-core/config.ts";
import type { Db } from "@transitopia/db/connect.ts";
import type { Health } from "@transitopia/shared/admin-api.ts";
import { recoverInterrupted, runOnce } from "@transitopia/db/jobs.ts";
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
import { dailyStats, hasRecording, type RealtimeFeed } from "./daily.ts";
import { buildData } from "./data-build.ts";

const TICK_MS = 5 * 60_000;
/** A daily job whose last success is older than this is reported unhealthy (h). */
const STALE_DAILY_H = 36;

export class Jobs {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private ticking: Promise<void> | undefined;
  private lastDataBuild: number | undefined;
  private recovered = false;

  private readonly db: Db | undefined;
  /** Every feed the regions show: the data build publishes them, statistics are of those with real time. */
  private readonly feeds: FeedInfo[];
  private readonly repo: CorrectionsRepo | undefined;
  private readonly env: ServerEnv;
  private readonly log: (msg: string) => void;

  constructor(opts: {
    db: Db | undefined;
    feeds: FeedInfo[];
    repo: CorrectionsRepo | undefined;
    env: ServerEnv;
    log?: (msg: string) => void;
  }) {
    this.db = opts.db;
    this.feeds = opts.feeds;
    this.repo = opts.repo;
    this.env = opts.env;
    this.log = opts.log ?? ((m) => console.log(`[jobs] ${m}`));
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const loop = async () => {
      // This process is the leader: runs another process left "running" were interrupted.
      if (this.db && !this.recovered) {
        this.recovered = true;
        const reset = await recoverInterrupted(this.db).catch((e: Error) => {
          this.log(`could not reset interrupted jobs: ${e.message}`);
          return [];
        });
        for (const r of reset)
          this.log(`${r.job}:${r.key} was interrupted; running it again`);
      }
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
    // Build first when a feed has nothing to serve yet (a fresh server, or a feed just added), else
    // at the set time.
    if (this.env.buildData) {
      const [h, m] = recording.dataBuildAt.split(":").map(Number);
      const due = wall.hour * 60 + wall.minute >= h! * 60 + m!;
      const missing = this.feeds.some(
        (f) => !existsSync(feedPaths(f.id).manifest),
      );
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
              feeds: this.feeds,
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
      const realtime = this.feeds.filter((f): f is FeedInfo & RealtimeFeed =>
        Boolean(f.realtime),
      );
      // Every finished service date still within the raw data's lifetime, oldest first.
      for (let d = recording.retentionDays - 1; d >= 1; d--) {
        const date = addDays(today, -d);
        if (
          now
          < serviceDayStart(date) + recording.afterServiceDayH * 3_600_000
        )
          continue;
        for (const feed of realtime) {
          if (!(await hasRecording(db, feed.id, date))) continue;
          await this.job("daily", `${feed.id}:${date}`, () =>
            dailyStats(db, feed, date, this.log),
          );
        }
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

  /** For /healthz: daily jobs that failed lately, or haven't succeeded for a while. */
  async health(): Promise<Health["checks"]> {
    if (!this.db) return {};
    const out: Health["checks"] = {};
    const failures = await this.db
      .selectFrom("job_runs")
      .select(["job", "key", "error"])
      .where("status", "=", "failed")
      .where("finished_at", ">", new Date(Date.now() - 3 * 86_400_000))
      .orderBy("finished_at", "desc")
      .execute();
    const latest = await this.db
      .selectFrom("job_runs")
      .select(({ fn }) => ["job", fn.max("finished_at").as("last")])
      .where("status", "=", "done")
      .groupBy("job")
      .execute();
    // Backups run in their own container (infra/backup) and record themselves here.
    for (const job of [
      "daily",
      ...(this.env.buildData ? ["data"] : []),
      ...(this.env.archiveRemote ? ["backup"] : []),
    ]) {
      const failed = failures.find((r) => r.job === job);
      const last = latest.find((r) => r.job === job)?.last;
      const lastOk = last ? new Date(last) : undefined;
      // Never having run (a new server) isn't a failure; not succeeding for a while is.
      const stale =
        lastOk !== undefined
        && Date.now() - lastOk.getTime() > STALE_DAILY_H * 3_600_000;
      out[`job:${job}`] = {
        ok: !failed && !stale,
        detail:
          failed ?
            `${job}:${failed.key} failed: ${(failed.error ?? "").split("\n")[0]}`
          : lastOk ? `last success ${lastOk.toISOString()}`
          : "no runs yet",
      };
    }
    return out;
  }
}
