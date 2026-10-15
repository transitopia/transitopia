import { afterEach, describe, expect, it, vi } from "vitest";
import { serviceDate } from "@transitopia/transit-core/time.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import translinkFeed from "@transitopia/config/feeds/translink/feed.json" with { type: "json" };
import { parseFeed } from "@transitopia/transit-core/config.ts";
import {
  fetchAlerts,
  fetchTripUpdates,
  tripFeedSummary,
  type Upstream,
} from "../src/rt/upstream.ts";
import { ServiceChanges } from "../src/rt/changes.ts";
import {
  alertActiveAt,
  changesView,
  EFFECT_DETOUR,
  EFFECT_NO_SERVICE,
  mergeAlerts,
  type RtRouteAlert,
} from "@transitopia/transit-core/rt/changes.ts";

const { FeedMessage } = GtfsRealtimeBindings.transit_realtime;
const UPSTREAM: Upstream = {
  name: "TransLink",
  rt: parseFeed(translinkFeed).realtime!,
  apiKey: "k",
};

function serve(entity: unknown[]): void {
  const buf = FeedMessage.encode(
    FeedMessage.create({
      header: { gtfsRealtimeVersion: "2.0", timestamp: 1790697910 },
      entity,
    } as never),
  ).finish();
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(new Blob([buf as Uint8Array<ArrayBuffer>]), {
          status: 200,
        }),
    ),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("trip-updates feed summary", () => {
  const feed = {
    trips: [
      { tripId: "a", routeId: "6641", stopDelays: 4 },
      {
        tripId: "b",
        routeId: "6641",
        startDate: serviceDate("20261012"),
        stopDelays: 0,
      },
    ],
    headerTs: 1_000_000,
    bytes: 2048,
  };

  it("counts trips matched to buses both ways, with unmatched examples", () => {
    const buses = new Map([
      ["a", "6641"],
      ["c", "6641"],
      ["d", undefined],
    ]);
    expect(tripFeedSummary(feed, buses, 1_030_000)).toEqual({
      at: 1_030_000,
      bytes: 2048,
      headerAgeS: 30,
      trips: 2,
      withStopDelays: 1,
      matched: 1,
      busesOnTrips: 3,
      busesMatched: 1,
      unmatchedTrips: [
        {
          tripId: "b",
          routeId: "6641",
          startDate: serviceDate("20261012"),
          stopDelays: 0,
        },
      ],
      unmatchedBuses: [{ tripId: "c", routeId: "6641" }, { tripId: "d" }],
    });
  });

  it("keeps at most five examples each way", () => {
    const many = {
      ...feed,
      trips: Array.from({ length: 8 }, (_, i) => ({
        tripId: `t${i}`,
        stopDelays: 1,
      })),
    };
    const buses = new Map(
      Array.from({ length: 8 }, (_, i) => [`b${i}`, undefined] as const),
    );
    const s = tripFeedSummary(many, buses, 1_000_000);
    expect(s.unmatchedTrips).toHaveLength(5);
    expect(s.unmatchedBuses).toHaveLength(5);
    expect(s.busesMatched).toBe(0);
  });
});

describe("GTFS-RT service changes: decoding", () => {
  it("reads cancelled trips and skipped stops from trip updates, without delays for either", async () => {
    // Shapes as seen in TransLink's feed on 2026-09-29.
    serve([
      {
        id: "15519786",
        tripUpdate: {
          trip: {
            tripId: "15519786",
            startDate: serviceDate("20260929"),
            scheduleRelationship: 0,
            routeId: "38311",
            directionId: 1,
          },
          stopTimeUpdate: [
            { stopSequence: 9, stopId: "2742", scheduleRelationship: 1 },
            {
              stopSequence: 10,
              stopId: "12950",
              arrival: { delay: 2768 },
              departure: { delay: 2768 },
              scheduleRelationship: 0,
            },
          ],
        },
      },
      {
        id: "15519634",
        tripUpdate: {
          trip: {
            tripId: "15519634",
            startDate: serviceDate("20260929"),
            scheduleRelationship: 3,
            routeId: "38311",
            directionId: 0,
          },
          stopTimeUpdate: [
            { stopSequence: 1, stopId: "4461", scheduleRelationship: 1 },
          ],
        },
      },
      {
        id: "x",
        tripUpdate: {
          trip: { tripId: "x", routeId: "38311" },
          stopTimeUpdate: [{ stopSequence: 3, arrival: { delay: 60 } }],
        },
      },
    ]);
    const { delays, changes, trips, headerTs, bytes } =
      await fetchTripUpdates(UPSTREAM);
    expect(delays.get("15519786")?.bySeq).toEqual([[10, 2768]]);
    // Every trip as sent, for matching against the buses (cancelled ones too).
    expect(trips).toEqual([
      {
        tripId: "15519786",
        routeId: "38311",
        startDate: serviceDate("20260929"),
        stopDelays: 1,
      },
      {
        tripId: "15519634",
        routeId: "38311",
        startDate: serviceDate("20260929"),
        stopDelays: 0,
      },
      { tripId: "x", routeId: "38311", stopDelays: 1 },
    ]);
    expect(headerTs).toBe(1790697910_000);
    expect(bytes).toBeGreaterThan(0);
    expect(delays.has("15519634")).toBe(false);
    expect(changes).toEqual([
      {
        tripId: "15519786",
        routeId: "38311",
        startDate: serviceDate("20260929"),
        cancelled: false,
        skippedStopIds: ["2742"],
      },
      {
        tripId: "15519634",
        routeId: "38311",
        startDate: serviceDate("20260929"),
        cancelled: true,
        skippedStopIds: ["4461"],
      },
    ]);
  });

  it("keeps the direction and trip an alert is narrowed to", async () => {
    serve([
      {
        id: "757897",
        alert: {
          activePeriod: [{ start: 1790694840, end: 1790705110 }],
          informedEntity: [
            {
              agencyId: "TL",
              routeId: "38311",
              routeType: 3,
              stopId: "13069",
              directionId: 1,
            },
            {
              agencyId: "TL",
              routeId: "38311",
              routeType: 3,
              stopId: "2742",
              directionId: 1,
            },
            { agencyId: "TL", routeId: "38311", trip: { tripId: "15519630" } },
          ],
          effect: EFFECT_DETOUR,
          headerText: {
            translation: [
              { text: "8:10am, R2 Park Royal detour.", language: "en" },
            ],
          },
        },
      },
    ]);
    const [a] = await fetchAlerts(UPSTREAM);
    expect(a!.entities).toEqual([
      { routeId: "38311", directionId: 1 },
      { routeId: "38311", tripId: "15519630" },
    ]);
    expect(a!.stopIds).toEqual(["13069", "2742"]);
    expect(a!.effect).toBe(EFFECT_DETOUR);
    expect(a!.periods).toEqual([
      { start: 1790694840_000, end: 1790705110_000 },
    ]);
  });
});

describe("ServiceChanges", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("keeps cancellations after the feed drops them, per service date, across restarts", async () => {
    dir = await mkdtemp(join(tmpdir(), "rt-changes-"));
    const sc = new ServiceChanges(dir, true);
    await sc.updateTrips(
      [
        {
          tripId: "t1",
          date: serviceDate("20260929"),
          cancelled: true,
          skippedStopIds: [],
        },
      ],
      1000,
    );
    await sc.updateTrips(
      [
        {
          tripId: "t2",
          date: serviceDate("20260929"),
          cancelled: false,
          skippedStopIds: ["a"],
        },
      ],
      2000,
    );
    await sc.updateTrips(
      [
        {
          tripId: "t1",
          date: serviceDate("20260929"),
          cancelled: true,
          skippedStopIds: [],
        },
        {
          tripId: "t2",
          date: serviceDate("20260929"),
          cancelled: false,
          skippedStopIds: ["b", "a"],
        },
      ],
      3000,
    );
    // t1 no longer reported: still recorded.
    await sc.updateTrips([], 4000);
    await sc.flushed();
    const reloaded = await new ServiceChanges(dir, true).get(
      serviceDate("20260929"),
    );
    expect(reloaded.cancelled).toEqual({ t1: [1000, 3000] });
    expect(reloaded.skipped).toEqual({ t2: ["a", "b"] });
    expect((await sc.get(serviceDate("20260930"))).cancelled).toEqual({});
  });

  it("versions each state of a day, keeping recent versions for their immutable URLs", async () => {
    const sc = new ServiceChanges("/nonexistent", false);
    const v1 = await sc.versioned(serviceDate("20260929"));
    expect(await sc.versioned(serviceDate("20260929"))).toBe(v1);
    await sc.updateTrips(
      [
        {
          tripId: "t1",
          date: serviceDate("20260929"),
          cancelled: true,
          skippedStopIds: [],
        },
      ],
      1000,
    );
    const v2 = await sc.versioned(serviceDate("20260929"));
    expect(v2.version).not.toBe(v1.version);
    expect(JSON.parse(v2.body).cancelled).toEqual({ t1: [1000, 1000] });
    expect(sc.version(serviceDate("20260929"), v1.version)).toBe(v1.body);
    expect(sc.version(serviceDate("20260929"), v2.version)).toBe(v2.body);
    expect(sc.version(serviceDate("20260929"), "000000000000")).toBeUndefined();
    // Only a few are kept.
    for (let i = 2; i < 8; i++) {
      await sc.updateTrips(
        [
          {
            tripId: `t${i}`,
            date: serviceDate("20260929"),
            cancelled: true,
            skippedStopIds: [],
          },
        ],
        1000,
      );
      await sc.versioned(serviceDate("20260929"));
    }
    expect(sc.version(serviceDate("20260929"), v1.version)).toBeUndefined();
  });

  it("records alerts under the local date, keeping when each was first and last seen", async () => {
    dir = await mkdtemp(join(tmpdir(), "rt-changes-"));
    const sc = new ServiceChanges(dir, false);
    const t0 = Date.UTC(2026, 8, 29, 15, 14); // 08:14 PDT
    const a = {
      id: "a1",
      entities: [{ routeKey: "R2", directionId: 1 }],
      stopIds: [],
      effect: EFFECT_DETOUR,
      periods: [],
      header: "v1",
      description: "",
    };
    await sc.updateAlerts([a], t0);
    await sc.updateAlerts([{ ...a, header: "UPDATE: v2" }], t0 + 300_000);
    const d = await sc.get(serviceDate("20260929"));
    expect(d.alerts).toEqual([
      { ...a, header: "UPDATE: v2", seen: [t0, t0 + 300_000] },
    ]);
  });
});

describe("route alerts", () => {
  const a: RtRouteAlert = {
    id: "a",
    entities: [],
    stopIds: [],
    periods: [{ start: 1000, end: 9000 }],
    header: "",
    description: "",
    seen: [2000, 5000],
  };
  it("apply within their period until withdrawn, plus one poll", () => {
    expect(alertActiveAt(a, 900, 100)).toBe(false);
    // From the period's start, even before it was first seen (e.g. recording started later).
    expect(alertActiveAt(a, 1500, 100)).toBe(true);
    expect(alertActiveAt(a, 5050, 100)).toBe(true);
    expect(alertActiveAt(a, 6000, 100)).toBe(false);
    // No start: from when first seen.
    expect(alertActiveAt({ ...a, periods: [{ end: 9000 }] }, 1500, 100)).toBe(
      false,
    );
    expect(alertActiveAt({ ...a, periods: [] }, 1950, 100)).toBe(true);
  });
  it("merge across days by id", () => {
    const m = mergeAlerts([
      {
        date: serviceDate("20260928"),
        cancelled: {},
        skipped: {},
        alerts: [{ ...a, seen: [100, 200] }],
      },
      {
        date: serviceDate("20260929"),
        cancelled: {},
        skipped: {},
        alerts: [{ ...a, seen: [300, 400] }],
      },
    ]);
    expect(m).toHaveLength(1);
    expect(m[0]!.seen).toEqual([100, 400]);
  });
});

describe("changesView", () => {
  it('takes cancellations from trip updates and from "no service" alerts naming a trip', () => {
    const base = {
      entities: [],
      stopIds: [],
      effect: EFFECT_NO_SERVICE,
      periods: [],
      description: "",
      seen: [0, 0] as [number, number],
    };
    const v = changesView(
      [
        {
          date: serviceDate("20260929"),
          cancelled: { tu1: [0, 0] },
          skipped: { t9: ["x"] },
          alerts: [
            // "R2 ... trip leaving Park Royal @ Bay 5 at 8:24 am is cancelled today due to traffic."
            {
              ...base,
              id: "a1",
              entities: [{ routeKey: "R2", tripId: "al1" }],
              header: "cancelled",
            },
            // "... at 8:00 am is cancelled today due to traffic. Resuming service at Lonsdale Quay."
            {
              ...base,
              id: "a2",
              entities: [{ routeKey: "R2", tripId: "part" }],
              stopIds: ["s1", "s2"],
              header: "resuming",
            },
          ],
        },
      ],
      0,
    );
    expect(v.cancelledTrips(serviceDate("20260929")).sort()).toEqual([
      "al1",
      "tu1",
    ]);
    expect(v.cancelled(serviceDate("20260929"), "part")).toBe(false);
    expect([...v.skipped(serviceDate("20260929"), "part")!]).toEqual([
      "s1",
      "s2",
    ]);
    expect([...v.skipped(serviceDate("20260929"), "t9")!]).toEqual(["x"]);
    expect(v.cancelled(serviceDate("20260930"), "tu1")).toBe(false);
  });
});
