// Leader election (apps/server/README.md#leader): exactly one process per deployment polls, records and
// dispatches; the others forward /rt/* to it.
//
// - With a database: a session advisory lock on a dedicated connection. Postgres releases it when
//   the session ends, so a crashed leader is replaced by whichever follower retries next. The
//   service_leader row only says where to forward. If the lock's connection drops, this process may
//   no longer be the leader while it still polls, so it exits and lets the supervisor restart it.
// - Without one (local runs): the lock file var/rt-history/.lock ({pid, port}), as before.

import { readFile, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import pg from "pg";
import type { Db } from "@transitopia/db/connect.ts";

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
  private readonly regionId: string;
  /** Where followers reach this process (e.g. http://server:8787), if it becomes the leader. */
  private readonly advertiseUrl: string | undefined;
  private readonly onLost: () => void;

  constructor(opts: {
    url: string;
    db: Db;
    regionId: string;
    advertiseUrl?: string | undefined;
    onLost: () => void;
  }) {
    this.url = opts.url;
    this.db = opts.db;
    this.regionId = opts.regionId;
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
      [`transitopia-leader:${this.regionId}`],
    );
    if (!rows[0]?.ok) {
      const row = await this.db
        .selectFrom("service_leader")
        .select("url")
        .where("region_id", "=", this.regionId)
        .executeTakeFirst();
      return { leader: false, url: row?.url ?? undefined };
    }
    this.held = true;
    const now = new Date();
    const row = {
      region_id: this.regionId,
      instance: hostname(),
      url: this.advertiseUrl ?? null,
      pid: process.pid,
      started_at: this.startedAt,
      heartbeat_at: now,
    };
    await this.db
      .insertInto("service_leader")
      .values(row)
      .onConflict((oc) => oc.column("region_id").doUpdateSet(row))
      .execute();
    this.heartbeat = setInterval(() => {
      void this.db
        .updateTable("service_leader")
        .set({ heartbeat_at: new Date() })
        .where("region_id", "=", this.regionId)
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

export class FileLeaderLock implements LeaderLock {
  private owns = false;
  private readonly path: string;
  private readonly port: number | undefined;

  constructor(path: string, port: number | undefined) {
    this.path = path;
    this.port = port;
  }

  async tryAcquire(): Promise<LeaderState> {
    if (this.owns) return { leader: true };
    try {
      const lock = JSON.parse(await readFile(this.path, "utf8")) as {
        pid: number;
        port?: number;
      };
      if (lock.pid !== process.pid && isAlive(lock.pid) && lock.port)
        return { leader: false, url: `http://localhost:${lock.port}` };
    } catch {
      // No lock (or unreadable): take it.
    }
    await writeFile(
      this.path,
      JSON.stringify({ pid: process.pid, port: this.port }),
    );
    this.owns = true;
    return { leader: true };
  }

  async release(): Promise<void> {
    if (!this.owns) return;
    this.owns = false;
    await rm(this.path, { force: true });
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
