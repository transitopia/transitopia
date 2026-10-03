// The server with PostgreSQL: recording every route, the request ledger across restarts, leader
// election, corrections and the admin API. Skipped without TEST_DATABASE_URL (infra/compose.dev.yml).

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import {
  createTestDb,
  TEST_DATABASE_URL,
  type TestDb,
} from "@transitopia/db/testing.ts";
import { RtService } from "../src/rt/service.ts";
import { Store } from "../src/store.ts";
import { PgLeaderLock } from "../src/leader.ts";
import { CorrectionsRepo } from "../src/corrections.ts";
import { DbTracksideStore } from "../src/trackside.ts";
import { Auth } from "../src/auth.ts";
import { createApp } from "../src/app.ts";
import { readEnv } from "../src/env.ts";
import type { Disruption } from "@transitopia/transit-core/disruption/types.ts";

const { FeedMessage } = GtfsRealtimeBindings.transit_realtime;
const REGION = "metro-vancouver";

function positionsFeed(): Uint8Array {
  const now = Math.floor(Date.now() / 1000);
  return FeedMessage.encode(
    FeedMessage.create({
      header: { gtfsRealtimeVersion: "2.0", timestamp: now },
      entity: [
        {
          id: "1",
          vehicle: {
            trip: { tripId: "t1", routeId: "not-drawn-1" },
            vehicle: { id: "v1", label: "1001" },
            position: { latitude: 49.28, longitude: -123.12 },
            timestamp: now,
          },
        },
        {
          id: "2",
          vehicle: {
            trip: { tripId: "t2", routeId: "not-drawn-2" },
            vehicle: { id: "v2" },
            position: { latitude: 49.2, longitude: -123.0 },
            timestamp: now,
          },
        },
      ],
    }),
  ).finish();
}

function emptyFeed(): Uint8Array {
  return FeedMessage.encode(
    FeedMessage.create({
      header: {
        gtfsRealtimeVersion: "2.0",
        timestamp: Math.floor(Date.now() / 1000),
      },
      entity: [],
    }),
  ).finish();
}

const respond = (bytes: Uint8Array) =>
  new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]), { status: 200 });

describe.skipIf(!TEST_DATABASE_URL)("server with a database", () => {
  let t: TestDb;
  let dir: string;
  const services: RtService[] = [];

  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(() => t?.drop());
  afterEach(async () => {
    for (const s of services.splice(0)) s.stop();
    vi.unstubAllGlobals();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const newService = async (lock?: PgLeaderLock) => {
    const s = new RtService({
      historyDir: dir,
      log: () => {},
      apiKey: "test-key",
      aisApiKey: null,
      dispatch: false,
      disruptionsDir: dir,
      store: new Store(t.db, REGION),
      leaderLock: lock,
    });
    services.push(s);
    await s.start(0);
    return s;
  };

  it("records every route's vehicles, shows only drawn routes, and keeps the ledger in the database", async () => {
    dir = await mkdtemp(join(tmpdir(), "rt-db-"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) =>
        respond(
          String(url).includes("gtfsposition") ? positionsFeed() : emptyFeed(),
        ),
      ),
    );
    let service = await newService();
    await vi.waitFor(async () => {
      const n = await t.db
        .selectFrom("upstream_requests")
        .select("id")
        .execute();
      expect(n.length).toBe(3);
    });
    await vi.waitFor(async () => {
      const rows = await t.db.selectFrom("rt_positions").selectAll().execute();
      expect(
        rows.map((r) => r.route_id ?? "").sort((a, b) => a.localeCompare(b)),
      ).toEqual(["not-drawn-1", "not-drawn-2"]);
      expect(rows.every((r) => r.route_key === null)).toBe(true);
    });
    // Clients only see routes we draw (none here).
    expect(service.liveResponse().snapshot?.vehicles).toEqual([]);
    // The hour file has every vehicle; /rt/history serves only drawn routes.
    const day = (await readdir(dir)).find((d) => /^\d{4}-/.test(d))!;
    const [hourFile] = await readdir(join(dir, day));
    const recorded = JSON.parse(
      (await readFile(join(dir, day, hourFile!), "utf8")).split("\n")[0]!,
    );
    expect(recorded.v.length).toBe(2);
    const hist = await service.handle(
      "/rt/history",
      new URLSearchParams({ date: day, hour: hourFile!.slice(0, 2) }),
    );
    expect(
      JSON.parse(
        gunzipSync(hist.body as Buffer)
          .toString("utf8")
          .split("\n")[0]!,
      ).v,
    ).toEqual([]);

    // A restart continues from the database's ledger instead of polling everything again.
    service.stop();
    service = await newService();
    const status = JSON.parse(
      String((await service.handle("/rt/status", new URLSearchParams())).body),
    );
    expect(status.budget.used24h).toBe(3);
    expect(status.budget.nextPollInS.positions).toBeGreaterThan(0);
  });

  it("elects one leader, and a follower forwards to it and takes over when it goes", async () => {
    const onLost = vi.fn();
    const a = new PgLeaderLock({
      url: t.url,
      db: t.db,
      regionId: REGION,
      advertiseUrl: "http://a:8787",
      onLost,
    });
    const b = new PgLeaderLock({
      url: t.url,
      db: t.db,
      regionId: REGION,
      advertiseUrl: "http://b:8787",
      onLost,
    });
    expect(await a.tryAcquire()).toEqual({ leader: true });
    expect(await b.tryAcquire()).toEqual({
      leader: false,
      url: "http://a:8787",
    });
    await a.release();
    expect(await b.tryAcquire()).toEqual({ leader: true });
    await b.release();
    // Releasing on purpose isn't losing the lock.
    expect(onLost).not.toHaveBeenCalled();
  });

  it("keeps a person's decision over an alert's draft, and applies only confirmed corrections", async () => {
    const repo = new CorrectionsRepo(t.db, REGION);
    const draft: Disruption = {
      id: "alert-1",
      source: "TransLink alert",
      text: "Single-tracking",
      status: "draft",
      alertId: "1",
      active: [
        {
          from: "2026-09-28T21:00:00-07:00",
          until: "2026-09-29T02:00:00-07:00",
        },
      ],
      singleTrack: [
        { line: "expo", between: ["Edmonds", "Royal Oak"], keep: "" },
      ],
    };
    expect(await repo.saveAlertDraft(draft)).toBe(true);
    // The same alert again changes nothing.
    expect(await repo.saveAlertDraft(draft)).toBe(false);
    expect((await repo.load()).disruptions).toEqual([]);
    await repo.saveDisruption({
      ...draft,
      singleTrack: [
        { ...draft.singleTrack![0]!, keep: "Edmonds Station @ Platform 2" },
      ],
    });
    await repo.setState("disruption", "alert-1", "confirmed", "someone");
    expect(await repo.saveAlertDraft({ ...draft, text: "UPDATE: …" })).toBe(
      false,
    );
    const applied = (await repo.load()).disruptions;
    expect(
      applied.map((d) => [d.id, d.status, d.singleTrack?.[0]?.keep]),
    ).toEqual([["alert-1", "confirmed", "Edmonds Station @ Platform 2"]]);
    const row = await repo.disruption("alert-1");
    expect(row?.dates).toEqual(["2026-09-28"]);
  });

  it("gates the admin API and validates corrections", async () => {
    dir = await mkdtemp(join(tmpdir(), "rt-db-"));
    const env = readEnv({
      ADMIN_DEV_TOKEN: "dev-token",
      ALLOWED_ORIGINS: "https://*.transitopia.org",
    });
    const service = new RtService({
      historyDir: dir,
      record: false,
      log: () => {},
      apiKey: null,
      aisApiKey: null,
      dispatch: false,
      disruptionsDir: dir,
    });
    services.push(service);
    const repo = new CorrectionsRepo(t.db, REGION);
    const app = createApp({
      service,
      auth: new Auth(t.db, env),
      env,
      db: t.db,
      repo,
    });
    const call = (path: string, init: RequestInit = {}, token = "dev-token") =>
      app.request(path, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...(init.headers as Record<string, string> | undefined),
        },
      });

    expect((await call("/admin/api/corrections", {}, "wrong")).status).toBe(
      401,
    );
    const cors = await app.request("/admin/api/corrections", {
      method: "OPTIONS",
      headers: {
        Origin: "https://www.transitopia.org",
        "Access-Control-Request-Method": "GET",
      },
    });
    expect(cors.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://www.transitopia.org",
    );

    const d: Disruption = {
      id: "works-1",
      source: "rider report",
      text: "Reduced service",
      active: [
        {
          from: "2026-10-03T08:00:00-07:00",
          until: "2026-10-03T12:00:00-07:00",
        },
      ],
      singleTrack: [
        {
          line: "canada",
          between: ["Bridgeport", "Richmond-Brighouse"],
          keep: "",
        },
      ],
    };
    expect(
      (
        await call("/admin/api/disruptions/works-1", {
          method: "PUT",
          body: JSON.stringify({ ...d, text: "" }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call("/admin/api/disruptions/works-1", {
          method: "PUT",
          body: JSON.stringify(d),
        })
      ).status,
    ).toBe(200);
    // Confirming needs the open track.
    const refused = await call("/admin/api/disruptions/works-1/confirm", {
      method: "POST",
    });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toMatch(
      /which track stays open/,
    );
    const fixed = {
      ...d,
      singleTrack: [
        { ...d.singleTrack![0]!, keep: "Lansdowne Station @ Platform 1" },
      ],
    };
    await call("/admin/api/disruptions/works-1", {
      method: "PUT",
      body: JSON.stringify(fixed),
    });
    expect(
      (await call("/admin/api/disruptions/works-1/confirm", { method: "POST" }))
        .status,
    ).toBe(200);
    const list = (await (await call("/admin/api/corrections")).json()) as {
      disruptions: { id: string; state: string; reviewed_by: string }[];
    };
    expect(list.disruptions.find((x) => x.id === "works-1")).toMatchObject({
      state: "confirmed",
      reviewed_by: "dev",
    });
    // Editing a confirmed disruption sends it back for review.
    await call("/admin/api/disruptions/works-1", {
      method: "PUT",
      body: JSON.stringify({ ...fixed, text: "Edited" }),
    });
    expect((await repo.disruption("works-1"))?.state).toBe("draft");
    const exported = (await (await call("/admin/api/export")).json()) as {
      disruptions: Record<string, unknown>;
    };
    expect(Object.keys(exported.disruptions)).toContain("alert-1");
    expect(Object.keys(exported.disruptions)).not.toContain("works-1");
  });

  it("stores trackside passes once, with their crops apart", async () => {
    const store = new DbTracksideStore(t.db, REGION);
    const jpeg = `data:image/jpeg;base64,${btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0))}`;
    const report = {
      id: "3f2c9a1e-0000-4000-8000-000000000009",
      setup: {
        id: "8a1b2c3d-0000-4000-8000-000000000002",
        at: [-123.1008, 49.27295] as [number, number],
        lines: ["expo"],
        tracks: [
          { segment: "w1.0", distanceM: 26, kind: "main", lines: ["expo"] },
        ],
        rightwardBearing: 110,
        hfovDeg: 65,
        frameWidth: 1920,
      },
      start: "2026-10-01T22:44:40.000Z",
      end: "2026-10-01T22:44:47.000Z",
      track: 0,
      trackSegment: "w1.0",
      extent: [0.13, 0.29] as [number, number],
      screen: "left" as const,
      bearing: 290,
      speedKmh: null,
      pxPerS: 1500,
      occluded: false,
      cars: [
        { number: "335", confidence: 1, reads: 1, crop: jpeg },
        { number: "336", confidence: 0.99, reads: 2 },
      ],
      source: "camera" as const,
    };
    expect(await store.add(report, "braden")).toBe("added");
    expect(await store.add({ ...report, speedKmh: 40 }, "braden")).toBe(
      "updated",
    );
    expect(await store.add(report, "someone-else")).toBe("duplicate");
    const [row] = await store.list(10);
    expect(row).toMatchObject({ id: report.id, createdBy: "braden" });
    expect(row!.report.speedKmh).toBe(40);
    expect(row!.report.cars.map((c) => c.number)).toEqual(["335", "336"]);
    expect(row!.report.cars[0]).not.toHaveProperty("crop");
    expect(row!.crops).toEqual([
      { idx: 0, reading: "335", confidence: 1, accepted: true, label: null },
    ]);
    expect((await store.crop(report.id, 0))?.slice(0, 2)).toEqual(
      Buffer.from([0xff, 0xd8]),
    );
  });
});
