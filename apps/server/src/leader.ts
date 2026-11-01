// Leader election (apps/server/README.md#leader): exactly one process per deployment polls, records and
// dispatches, for every feed and rail network it serves; the others forward /rt/* to it.
//
// A session advisory lock on a dedicated connection. Postgres releases it when the session ends, so a
// crashed leader is replaced by whichever follower retries next. The service_leader row only says
// where to forward. If the lock's connection drops, this process may no longer be the leader while
// it still polls, so it exits and lets the supervisor restart it.

import { hostname } from "node:os";
import pg from "pg";
import type { Db } from "@transitopia/db/connect.ts";

/** The advisory lock's name: one per database, so one leader per deployment. */
const LOCK = "transitopia-leader";

export type LeaderState =
  { leader: true } | { leader: false; url?: string | undefined };

export interface LeaderLock {
  tryAcquire(): Promise<LeaderState>;
  release(): Promise<void>;
}

export class PgLeaderLock implements LeaderLock {
  private client: pg.Client | undefined;
  private held = false;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private readonly startedAt = new Date();

  private readonly url: string;
  private readonly db: Db;
  /** Where followers reach this process (e.g. http://server:8787), if it becomes the leader. */
  private readonly advertiseUrl: string | undefined;
  private readonly onLost: () => void;

  constructor(opts: {
    url: string;
    db: Db;
    advertiseUrl?: string | undefined;
    onLost: () => void;
  }) {
    this.url = opts.url;
    this.db = opts.db;
    this.advertiseUrl = opts.advertiseUrl;
    this.onLost = opts.onLost;
  }

  async tryAcquire(): Promise<LeaderState> {
    if (this.held) return { leader: true };
    if (!this.client) {
      const client = new pg.Client({ connectionString: this.url });
      client.on("error", () => this.lost());
      client.on("end", () => this.lost());
      await client.connect();
      this.client = client;
    }
    const { rows } = await this.client.query<{ ok: boolean }>(
      "select pg_try_advisory_lock(hashtext($1)) as ok",
      [LOCK],
    );
    if (!rows[0]?.ok) {
      const row = await this.db
        .selectFrom("service_leader")
        .select("url")
        .executeTakeFirst();
      return { leader: false, url: row?.url ?? undefined };
    }
    this.held = true;
    const now = new Date();
    const row = {
      instance: hostname(),
      url: this.advertiseUrl ?? null,
      pid: process.pid,
      started_at: this.startedAt,
      heartbeat_at: now,
    };
    await this.db
      .insertInto("service_leader")
      .values(row)
      .onConflict((oc) => oc.column("singleton").doUpdateSet(row))
      .execute();
    this.heartbeat = setInterval(() => {
      void this.db
        .updateTable("service_leader")
        .set({ heartbeat_at: new Date() })
        .where("pid", "=", process.pid)
        .execute()
        .catch(() => {});
    }, 30_000);
    return { leader: true };
  }

  private lost(): void {
    const wasHeld = this.held;
    this.held = false;
    this.client = undefined;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (wasHeld) this.onLost();
  }

  async release(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    const client = this.client;
    this.client = undefined;
    this.held = false;
    await client?.end().catch(() => {});
  }
}
