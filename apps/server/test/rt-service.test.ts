import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import { RtService } from "../src/rt/service.ts";
import { health, type AppDeps } from "../src/app.ts";

const { FeedMessage } = GtfsRealtimeBindings.transit_realtime;

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

/** A positions feed with buses on trips. */
function positionsFeed(tripIds: string[]): Uint8Array {
  return FeedMessage.encode(
    FeedMessage.create({
      header: {
        gtfsRealtimeVersion: "2.0",
        timestamp: Math.floor(Date.now() / 1000),
      },
      entity: tripIds.map((tripId, i) => ({
        id: `v${i}`,
        vehicle: {
          trip: { tripId },
          vehicle: { id: `bus${i}` },
          position: { latitude: 49.26, longitude: -123.1 },
          timestamp: Math.floor(Date.now() / 1000),
        },
      })),
    }),
  ).finish();
}

/** A trip-updates feed with one stop delay per trip. */
function tripUpdatesFeed(tripIds: string[]): Uint8Array {
  return FeedMessage.encode(
    FeedMessage.create({
      header: {
        gtfsRealtimeVersion: "2.0",
        timestamp: Math.floor(Date.now() / 1000),
      },
      entity: tripIds.map((tripId) => ({
        id: tripId,
        tripUpdate: {
          trip: { tripId, routeId: "6641", startDate: "20261012" },
          stopTimeUpdate: [{ stopSequence: 3, arrival: { delay: 60 } }],
        },
      })),
    }),
  ).finish();
}

const feedResponse = (body: Uint8Array) =>
  new Response(new Blob([body as Uint8Array<ArrayBuffer>]), { status: 200 });

describe("RtService", () => {
  let dir: string | undefined;
  let service: RtService | undefined;

  afterEach(async () => {
    service?.stop();
    vi.unstubAllGlobals();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("serves many concurrent clients from one upstream poll", async () => {
    dir = await mkdtemp(join(tmpdir(), "rt-test-"));
    const upstream = vi.fn(async (url: string | URL) => {
      expect(String(url)).toMatch(/gtfsapi\.translink\.ca/);
      return new Response(new Blob([emptyFeed() as Uint8Array<ArrayBuffer>]), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", upstream);

    service = new RtService({
      historyDir: dir,
      record: false,
      log: () => {},
      apiKey: "test-key",
      dispatch: false,
      disruptionsDir: dir,
    });
    await service.start(0);
    // Let the first positions + trip-updates + alerts polls complete.
    await vi.waitFor(() =>
      expect(service!.liveResponse().snapshot).not.toBeNull(),
    );
    await vi.waitFor(() => expect(upstream.mock.calls.length).toBe(3));

    const before = upstream.mock.calls.length;
    const responses = await Promise.all(
      Array.from({ length: 100 }, () =>
        service!.handle("/rt/live", new URLSearchParams()),
      ),
    );
    expect(upstream.mock.calls.length).toBe(before);
    expect(before).toBe(3);
    for (const r of responses) {
      expect(r.status).toBe(200);
      expect(r.headers["Access-Control-Allow-Origin"]).toBe("*");
      expect(r.headers["Cache-Control"]).toMatch(/max-age=10/);
      // The key must never appear in responses.
      expect(String(r.body)).not.toContain("test-key");
    }
  });

  it("records each request in a ledger and resumes the schedule after a restart", async () => {
    dir = await mkdtemp(join(tmpdir(), "rt-test-"));
    const upstream = vi.fn(
      async () =>
        new Response(new Blob([emptyFeed() as Uint8Array<ArrayBuffer>]), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", upstream);
    const opts = {
      historyDir: dir,
      record: false,
      log: () => {},
      apiKey: "test-key",
      dispatch: false as const,
      disruptionsDir: dir,
    };
    service = new RtService(opts);
    await service.start(0);
    await vi.waitFor(() => expect(upstream.mock.calls.length).toBe(3));
    await vi.waitFor(async () =>
      expect(
        JSON.parse(await readFile(join(dir!, "requests.json"), "utf8"))
          .requests,
      ).toHaveLength(3),
    );
    service.stop();

    // A restart right away polls nothing until each feed's interval has passed.
    service = new RtService(opts);
    await service.start(0);
    await new Promise((r) => setTimeout(r, 200));
    expect(upstream.mock.calls.length).toBe(3);
    const status = JSON.parse(
      String((await service.handle("/rt/status", new URLSearchParams())).body),
    );
    expect(status.budget.used24h).toBe(3);
    expect(status.budget.nextPollInS.positions).toBeGreaterThan(30);
  });

  it("stops polling at the daily cap", async () => {
    dir = await mkdtemp(join(tmpdir(), "rt-test-"));
    const hourAgo = Date.now() - 3_600_000;
    const requests = Array.from({ length: 1000 }, (_, i) => [
      hourAgo + i,
      "positions",
    ]);
    await writeFile(join(dir, "requests.json"), JSON.stringify({ requests }));
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    service = new RtService({
      historyDir: dir,
      record: false,
      log: () => {},
      apiKey: "test-key",
      dispatch: false,
      disruptionsDir: dir,
    });
    await service.start(0);
    await vi.waitFor(async () =>
      expect(
        JSON.parse(
          String(
            (await service!.handle("/rt/status", new URLSearchParams())).body,
          ),
        ).budget.capped,
      ).toBe(true),
    );
    expect(upstream).not.toHaveBeenCalled();
  });

  it("reports no key without calling upstream", async () => {
    dir = await mkdtemp(join(tmpdir(), "rt-test-"));
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    service = new RtService({
      historyDir: dir,
      record: false,
      log: () => {},
      apiKey: null,
      dispatch: false,
    });
    await service.start(0);
    const r = await service.handle("/rt/live", new URLSearchParams());
    const body = JSON.parse(String(r.body));
    expect(body.snapshot).toBeNull();
    expect(body.stale).toBe(true);
    expect(body.error).toMatch(/API key/);
    expect(upstream).not.toHaveBeenCalled();
    // Live dispatch is off here: no pointer, and its endpoints say so.
    expect(body.dispatch).toBeUndefined();
    expect(
      (await service.handle("/rt/dispatch", new URLSearchParams())).status,
    ).toBe(404);
  });

  it("keeps a trip-updates failure visible after positions succeed, and fails health", async () => {
    dir = await mkdtemp(join(tmpdir(), "rt-test-"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) =>
        /gtfsrealtime/.test(String(url)) ?
          new Response("upstream broke", { status: 500 })
        : feedResponse(
            /gtfsposition/.test(String(url)) ?
              positionsFeed(["t1", "t2"])
            : emptyFeed(),
          ),
      ),
    );
    service = new RtService({
      historyDir: dir,
      record: false,
      log: () => {},
      apiKey: "test-key",
      dispatch: false,
      disruptionsDir: dir,
    });
    await service.start(0);
    const status = async () =>
      JSON.parse(
        String(
          (await service!.handle("/rt/status", new URLSearchParams())).body,
        ),
      );
    await vi.waitFor(async () =>
      expect((await status()).feeds.tripUpdates.lastError).toMatch(/500/),
    );
    await vi.waitFor(async () =>
      expect((await status()).feeds.positions.lastOkAgeS).not.toBeNull(),
    );
    expect((await status()).feeds.tripUpdates.lastError).toMatch(/500/);
    const h = await health({ service } as unknown as AppDeps);
    expect(h.ok).toBe(false);
    expect(h.checks.tripUpdates?.ok).toBe(false);
    expect(h.checks.tripUpdates?.detail).toMatch(
      /no successful poll yet; last error/,
    );
  });

  it("fails health when trip updates succeed but give no delays for the buses", async () => {
    dir = await mkdtemp(join(tmpdir(), "rt-test-"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) =>
        feedResponse(
          /gtfsposition/.test(String(url)) ?
            positionsFeed(["t1", "t2"])
          : emptyFeed(),
        ),
      ),
    );
    service = new RtService({
      historyDir: dir,
      record: false,
      log: () => {},
      apiKey: "test-key",
      dispatch: false,
      disruptionsDir: dir,
    });
    await service.start(0);
    // Positions polled again once trip updates have been read (the first may come back before them).
    await vi.waitFor(async () => {
      const st = JSON.parse(
        String(
          (await service!.handle("/rt/status", new URLSearchParams())).body,
        ),
      );
      expect(st.feeds.tripUpdates.lastOkAgeS).not.toBeNull();
    });
    await (
      service as unknown as { pollPositions(): Promise<void> }
    ).pollPositions();
    const h = await health({ service } as unknown as AppDeps);
    expect(h.checks.tripUpdates?.ok).toBe(false);
    expect(h.checks.tripUpdates?.detail).toMatch(
      /0 % of vehicles have a delay/,
    );
  });

  it("summarises each trip-updates poll against the buses, and logs when few match", async () => {
    dir = await mkdtemp(join(tmpdir(), "rt-test-"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) =>
        feedResponse(
          /gtfsposition/.test(String(url)) ? positionsFeed(["t1", "t2"])
          : /gtfsrealtime/.test(String(url)) ? tripUpdatesFeed(["t9"])
          : emptyFeed(),
        ),
      ),
    );
    const logs: string[] = [];
    service = new RtService({
      historyDir: dir,
      record: false,
      log: (m: string) => logs.push(m),
      apiKey: "test-key",
      dispatch: false,
      disruptionsDir: dir,
    });
    await service.start(0);
    await vi.waitFor(() =>
      expect(service!.liveResponse().snapshot).not.toBeNull(),
    );
    // The first trip-updates poll may have come before any positions: poll again now.
    const internals = service as unknown as {
      pollTripUpdates(): Promise<number>;
    };
    expect(await internals.pollTripUpdates()).toBeGreaterThan(0);
    const { tripFeed } = JSON.parse(
      String((await service.handle("/rt/status", new URLSearchParams())).body),
    );
    expect(tripFeed).toMatchObject({
      trips: 1,
      withStopDelays: 1,
      matched: 0,
      busesOnTrips: 2,
      busesMatched: 0,
      unmatchedTrips: [
        { tripId: "t9", routeId: "6641", startDate: "20261012" },
      ],
      unmatchedBuses: [{ tripId: "t1" }, { tripId: "t2" }],
    });
    expect(logs.join("\n")).toMatch(
      /trip updates match few buses: 0 of 2 .*Unmatched feed trips: t9 \(route 6641\)/,
    );
  });
});
