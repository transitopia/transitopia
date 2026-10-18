// The feature registry in PostgreSQL: reconciliation over feed versions (ranges of refs, IDs kept),
// the admin changes, lookups by ID and ref, the migration's statistics views. Skipped without
// TEST_DATABASE_URL (infra/compose.dev.yml).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import {
  createTestDb,
  TEST_DATABASE_URL,
  type TestDb,
} from "@transitopia/db/testing.ts";
import { parseKey } from "@transitopia/shared/features.ts";
import type {
  FeedRecords,
  FeedStop,
} from "@transitopia/transit-core/features/reconcile.ts";
import { reconcileConfig } from "../src/config.ts";
import { reconcileVersion } from "../src/features/reconcile.ts";
import {
  childrenOf,
  findFeature,
  mergeFeatures,
  newExchange,
  resolveKey,
  retire,
  searchFeatures,
  setParent,
} from "../src/features/registry.ts";
import { loadRegistry, registryFromDb } from "../src/features/export.ts";
import { syncSources } from "../src/sources.ts";

const M = 1 / 111_195;
const FEED = { id: "translink", operator: "translink" };

const stop = (
  id: string,
  name: string,
  lat: number,
  more: Partial<FeedStop> = {},
): FeedStop => ({
  id,
  name,
  lon: -123,
  lat: 49 + lat * M,
  station: false,
  nonBus: false,
  ...more,
});

const records = (): FeedRecords => ({
  stops: [
    stop("99939", "Joyce-Collingwood Station", 0, { station: true }),
    stop("11001", "Joyce-Collingwood Station @ Platform 1", 5, {
      parent: "99939",
      nonBus: true,
    }),
    stop("13001", "Blanca Loop @ Bay 1", 5000, { code: "60001" }),
    stop("13002", "Blanca Loop @ Bay 2", 5030, { code: "60002" }),
    stop("14001", "Main St @ 1st Ave", 9000, { code: "70001" }),
  ],
  routes: [{ id: "6612", shortName: "004", longName: "Powell/UBC" }],
});

describe.skipIf(!TEST_DATABASE_URL)("feature registry", () => {
  let t: TestDb;
  const seqs: number[] = [];

  beforeAll(async () => {
    t = await createTestDb();
    await syncSources(t.db);
    for (const [i, version] of ["V1", "V2", "V3"].entries()) {
      const r = await t.db
        .insertInto("gtfs_feeds")
        .values({
          feed_id: "translink",
          version,
          start_date: `2026-10-0${i + 1}`,
          end_date: "2026-12-31",
          fetched_at: new Date(),
          sha256: "x",
          bytes: 1,
          object_key: null,
        })
        .returning("seq")
        .executeTakeFirstOrThrow();
      seqs.push(r.seq);
    }
  });
  afterAll(() => t?.drop());

  it("links feeds to their operators", async () => {
    const f = await t.db
      .selectFrom("feeds")
      .select("operator_id")
      .where("id", "=", "translink")
      .executeTakeFirstOrThrow();
    expect(f.operator_id).toBe("translink");
  });

  it("mints IDs once and carries refs on over feed versions", async () => {
    const first = await reconcileVersion(t.db, {
      feed: FEED,
      version: "V1",
      seq: seqs[0]!,
      prevSeq: undefined,
      records: records(),
      settings: reconcileConfig,
    });
    // A station, an exchange, four stops and a route.
    expect(first.minted).toBe(7);
    const blanca = (await findFeature(t.db, "stop:translink:60001"))!;
    expect(blanca.kind).toBe("stop");
    expect(parseKey(blanca.id)).toMatchObject({ form: "id", kind: "stop" });
    const loop = (await findFeature(t.db, blanca.parentId!))!;
    expect(loop).toMatchObject({ kind: "exchange", name: "Blanca Loop" });

    const second = await reconcileVersion(t.db, {
      feed: FEED,
      version: "V2",
      seq: seqs[1]!,
      prevSeq: seqs[0],
      records: records(),
      settings: reconcileConfig,
    });
    expect(second).toMatchObject({ minted: 0, refsAdded: 0 });
    expect(second.refsExtended).toBe(first.refsAdded);
    const ranges = await sql<{ versions: string }>`
      select distinct versions::text from feature_refs`.execute(t.db);
    expect(ranges.rows.map((r) => r.versions)).toEqual([
      `[${seqs[0]},${seqs[1]! + 1})`,
    ]);
    // The ID with a name suffix, and the stop by its stop_id, find the same stop.
    expect((await findFeature(t.db, `${blanca.id}-60001`))!.id).toBe(blanca.id);
    expect((await findFeature(t.db, "gtfs-stop:translink:13001"))!.id).toBe(
      blanca.id,
    );
    const marked = await t.db
      .selectFrom("gtfs_feeds")
      .select("version")
      .where("reconciled_at", "is not", null)
      .execute();
    expect(marked.map((r) => r.version).sort()).toEqual(["V1", "V2"]);
  });

  it("keeps an admin's containment: Blanca Loop's bays detached, and a new bay with them", async () => {
    const bay1 = (await findFeature(t.db, "stop:translink:60001"))!;
    const bay2 = (await findFeature(t.db, "stop:translink:60002"))!;
    const loop = bay1.parentId!;
    await expect(retire(t.db, loop)).rejects.toThrow(/still has 2 stops/);
    await setParent(t.db, bay1.id, null);
    await setParent(t.db, bay2.id, null);
    await retire(t.db, loop);
    expect(await childrenOf(t.db, loop)).toEqual([]);
    const changes = await t.db
      .selectFrom("feature_changes")
      .select(["feature_id", "action"])
      .orderBy("id")
      .execute();
    expect(changes.map((c) => c.action)).toEqual([
      "set-parent",
      "set-parent",
      "retire",
    ]);

    const v3 = records();
    v3.stops.push(
      stop("13003", "Blanca Loop @ Bay 3", 5060, { code: "60003" }),
    );
    const r = await reconcileVersion(t.db, {
      feed: FEED,
      version: "V3",
      seq: seqs[2]!,
      prevSeq: seqs[1],
      records: v3,
      settings: reconcileConfig,
    });
    expect(r.minted).toBe(1);
    const bay3 = (await findFeature(t.db, "stop:translink:60003"))!;
    expect(bay3.parentId).toBeNull();
    expect((await findFeature(t.db, bay1.id))!.parentId).toBeNull();
  });

  it("refuses containment that isn't a stop in a station or exchange", async () => {
    const station = (await findFeature(t.db, "gtfs-stop:translink:99939"))!;
    const route = (await findFeature(t.db, "gtfs-route:translink:6612"))!;
    const stop = (await findFeature(t.db, "stop:translink:70001"))!;
    await expect(setParent(t.db, station.id, null)).rejects.toThrow(
      /not a stop/,
    );
    await expect(setParent(t.db, stop.id, route.id)).rejects.toThrow(
      /station or exchange/,
    );
    await setParent(t.db, stop.id, station.id);
    expect((await findFeature(t.db, stop.id))!.parentId).toBe(station.id);
  });

  it("follows a route's statistics across feed versions by its feature", async () => {
    const route = (await findFeature(t.db, "gtfs-route:translink:6612"))!;
    expect(route.name).toBe("4");
    for (const [date, version] of [
      ["2026-10-01", "V1"],
      ["2026-10-02", "V2"],
    ] as const)
      await t.db
        .insertInto("route_stats_daily")
        .values({
          feed_id: "translink",
          service_date: date,
          route_id: "6612",
          route_short_name: "004",
          direction_id: 0,
          band: "all",
          metrics: "{}",
          coverage: 1,
          stats_version: 1,
          feed_version: version,
        })
        .execute();
    const rows = await sql<{ route: string; service_date: string }>`
      select route, service_date from route_stats_daily_by_feature order by service_date`.execute(
      t.db,
    );
    expect(rows.rows).toEqual([
      { route: route.id, service_date: "2026-10-01" },
      { route: route.id, service_date: "2026-10-02" },
    ]);
  });

  it("makes an exchange of stops, and merges duplicates with one-hop redirects", async () => {
    const bay1 = (await findFeature(t.db, "stop:translink:60001"))!;
    const bay2 = (await findFeature(t.db, "stop:translink:60002"))!;
    const ex = await newExchange(t.db, "Blanca Loop", [bay1.id, bay2.id]);
    expect((await childrenOf(t.db, ex)).map((c) => c.id).sort()).toEqual(
      [bay1.id, bay2.id].sort(),
    );
    const ex2 = await newExchange(t.db, "Blanca Loop (again)", [bay1.id]);
    await mergeFeatures(t.db, ex2, ex);
    // Its stop moved with it, and its ID redirects.
    expect((await findFeature(t.db, bay1.id))!.parentId).toBe(ex);
    expect(await findFeature(t.db, ex2)).toMatchObject({
      id: ex,
      redirectedFrom: ex2,
    });
    await expect(mergeFeatures(t.db, ex, ex2)).rejects.toThrow(
      /merge into that/,
    );
    await expect(mergeFeatures(t.db, ex, bay1.id)).rejects.toThrow(/exchange/);
    // Nor into a retired one: its stops would sit in a place that isn't one.
    const ex3 = await newExchange(t.db, "Spare", [bay2.id]);
    await setParent(t.db, bay2.id, ex);
    await retire(t.db, ex3);
    const ex4 = await newExchange(t.db, "Another", [bay2.id]);
    await expect(mergeFeatures(t.db, ex4, ex3)).rejects.toThrow(/retired/);
    expect((await searchFeatures(t.db, "blanca")).map((f) => f.kind)).toContain(
      "exchange",
    );
  });

  it("resolves keys for the API, by date for GTFS refs", async () => {
    const r = await resolveKey(t.db, "stop:translink:70001", "20261002");
    expect(r).toMatchObject({ kind: "stop", suffix: "70001" });
    expect(r !== "unminted" && r?.bbox).toBeTruthy();
    expect(await resolveKey(t.db, "osm-way:1")).toBe("unminted");
    expect(await resolveKey(t.db, "sn-00000000")).toBeUndefined();
  });

  it("round-trips the registry through its export", async () => {
    const before = await registryFromDb(t.db);
    await loadRegistry(t.db, before);
    const after = await registryFromDb(t.db);
    expect(after.features).toEqual(before.features);
    expect(after.refs).toEqual(before.refs);
    expect(after.versions.map((v) => [v.version, v.seq])).toEqual(
      before.versions.map((v) => [v.version, v.seq]),
    );
  });
});
