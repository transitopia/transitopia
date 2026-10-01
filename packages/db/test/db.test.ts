import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import {
  createTestDb,
  TEST_DATABASE_URL,
  type TestDb,
} from "../src/testing.ts";
import { migrate } from "../src/migrate.ts";
import { dropExpiredPartitions, ensurePartitions } from "../src/partitions.ts";
import { recoverInterrupted, runOnce } from "../src/jobs.ts";

describe.skipIf(!TEST_DATABASE_URL)("database", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(() => t?.drop());

  it("migrates once, and again is a no-op", async () => {
    expect(await migrate(t.pool)).toEqual([]);
    const r = await t.db.selectFrom("regions").selectAll().execute();
    expect(r.map((x) => x.id)).toEqual(["metro-vancouver"]);
  });

  it("keeps service dates as strings and bigints as numbers", async () => {
    await t.db
      .insertInto("trip_changes")
      .values({
        region_id: "metro-vancouver",
        service_date: "2026-09-29",
        trip_id: "t1",
        route_id: "6641",
        cancelled: true,
        skipped_stop_ids: [],
        first_seen: new Date(),
        last_seen: new Date(),
      })
      .execute();
    const row = await t.db
      .selectFrom("trip_changes")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(row.service_date).toBe("2026-09-29");
    const id = await t.db
      .insertInto("upstream_requests")
      .values({
        provider: "translink",
        feed: "positions",
        ts: new Date(),
        status: 200,
        bytes: 1,
        error: null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    expect(typeof id.id).toBe("number");
  });

  it("creates daily partitions ahead and drops expired ones", async () => {
    const now = Date.parse("2026-09-29T12:00:00Z");
    await ensurePartitions(t.db, now);
    await t.db
      .insertInto("rt_positions")
      .values({
        region_id: "metro-vancouver",
        fetched_at: new Date(now),
        vehicle_id: "v",
        label: null,
        trip_id: null,
        route_id: null,
        route_key: null,
        lat: 49.28,
        lon: -123.1,
        bearing: null,
        ts: new Date(now),
        stop_seq: null,
        stop_id: null,
        status: null,
        delay: null,
      })
      .execute();
    const dropped = await dropExpiredPartitions(
      t.db,
      Date.parse("2026-09-29T00:00:00Z"),
    );
    expect(dropped.sort()).toEqual([
      "ais_fixes_20260928",
      "rt_positions_20260928",
    ]);
    const { rows } = await sql<{
      n: number;
    }>`select count(*)::int as n from rt_positions`.execute(t.db);
    expect(rows[0]!.n).toBe(1);
  });

  it("runs a job once per key and retries failures", async () => {
    let calls = 0;
    const fail = async () => {
      calls++;
      throw new Error("boom");
    };
    expect(await runOnce(t.db, "j", "2026-09-29", fail)).toBe("failed");
    // Not retried straight away.
    expect(await runOnce(t.db, "j", "2026-09-29", async () => calls++)).toBe(
      "skipped",
    );
    expect(
      await runOnce(t.db, "j", "2026-09-29", async () => calls++, {
        retryAfterMs: 0,
      }),
    ).toBe("done");
    expect(await runOnce(t.db, "j", "2026-09-29", async () => calls++)).toBe(
      "skipped",
    );
    expect(calls).toBe(2);
  });

  it("reruns a job interrupted mid-run as soon as the next leader starts", async () => {
    let calls = 0;
    // A run left "running" by a process that stopped.
    await t.db
      .insertInto("job_runs")
      .values({
        job: "data",
        key: "20261001",
        status: "running",
        started_at: new Date(),
        finished_at: null,
        error: null,
        detail: null,
      })
      .execute();
    expect(await runOnce(t.db, "data", "20261001", async () => calls++)).toBe(
      "skipped",
    );
    expect(await recoverInterrupted(t.db)).toEqual([
      { job: "data", key: "20261001" },
    ]);
    expect(await runOnce(t.db, "data", "20261001", async () => calls++)).toBe(
      "done",
    );
    expect(calls).toBe(1);
  });
});
