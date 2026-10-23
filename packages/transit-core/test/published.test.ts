import { describe, expect, it } from "vitest";
import { serviceDate } from "../src/time.ts";
import {
  assemblePlan,
  decodeCore,
  decodeCorridorInfo,
  decodeCorridors,
  decodeLine,
  decodeShapes,
  decodeTrips,
  encodeLine,
  publishPlan,
  railTripFiles,
  sortTrips,
  tripFilesFor,
  type PublishedCorridorInfo,
  decodePatternPaths,
  type PublishedPatternPaths,
  type PublishedCorridors,
  type PublishedShapes,
  type PublishedTrips,
} from "../src/plan/published.ts";
import { CorridorFrequency } from "../src/plan/corridor-frequency.ts";
import { PLAN_TILE_LAYERS, planTileFeatures } from "../src/plan/tiles.ts";
import type { PathStep, PlanTrip, ServicePlan } from "../src/plan/types.ts";
import {
  preparePlan,
  scheduledVehicles,
  withServiceTrips,
} from "../src/schedule/engine.ts";
import type { KinematicsConfig } from "../src/movement/kinematics.ts";

const kin: KinematicsConfig = {
  modes: {
    skytrain: {
      accel: 1,
      decel: 1,
      maxSpeed: 80,
      minCruiseFraction: 0.6,
      dwell: 20,
      length: 68,
      width: 3,
      profile: "trapezoid",
    },
    bus: {
      accel: 1,
      decel: 1,
      maxSpeed: 60,
      minCruiseFraction: 0,
      dwell: 0,
      length: 18,
      width: 2.6,
      profile: "linear",
    },
  },
  routes: {},
  sizing: { minPixelLength: 14, minPixelWidth: 6, minScaleByZoom: [[0, 1]] },
};

const H = 3600;
const trip = (
  id: string,
  pattern: number,
  service: string,
  start: number,
  extra: Partial<PlanTrip> = {},
): PlanTrip => ({
  id,
  pattern,
  service,
  headsign: pattern === 0 ? "East" : "Downtown",
  start,
  arr: [0, 120, 300],
  ...extra,
});

/** Two routes along one street: a train, and a bus with trips after midnight and an odd dwell. */
function fixture(): ServicePlan {
  return {
    schema: 1,
    feed: "translink",
    feedVersion: "test",
    feedStart: serviceDate("20260901"),
    feedEnd: serviceDate("20261231"),
    timezone: "America/Vancouver",
    builtAt: "",
    routes: [
      {
        key: "expo",
        label: "Expo",
        kind: "skytrain",
        mode: "skytrain",
        color: "#0033a0",
        textColor: "#fff",
        gtfsRouteId: "1",
      },
      {
        key: "9",
        label: "9 Broadway",
        kind: "bus",
        mode: "bus",
        category: "regular",
        color: "#666",
        textColor: "#fff",
        gtfsRouteId: "9",
      },
    ],
    stops: [
      { id: "A", name: "A", lon: -123.1, lat: 49.25, code: "50001" },
      {
        id: "B",
        name: "B @ Platform 1",
        lon: -123.086251,
        lat: 49.25,
        parent: "S",
        platform: "1",
      },
      { id: "C", name: "C", lon: -123.0725, lat: 49.250001 },
    ],
    stations: [],
    hubs: [],
    shapes: {
      s: [
        [-123.1, 49.25],
        [-123.08625, 49.25],
        [-123.0725, 49.25],
      ],
    },
    patterns: [
      {
        id: 0,
        route: "expo",
        direction: 0,
        shape: "s",
        stops: [0, 1, 2],
        dist: [0, 1000, 2000],
      },
      {
        id: 1,
        route: "9",
        direction: 1,
        shape: "s",
        stops: [0, 1, 2],
        dist: [0, 1000, 2000],
        access: [0, 0, 2],
      },
    ],
    // In the order build-schedule writes them.
    trips: sortTrips([
      trip("101", 0, "wk", 6 * H, { block: "7" }),
      trip("102", 0, "wk", 23.5 * H, { block: "7" }),
      trip("201", 1, "wk", 8 * H, { block: "b-1", dep: [0, 150, 300] }),
      trip("202", 1, "wk", 8 * H + 600, { block: "b-1" }),
      trip("203", 1, "wk", 24.5 * H),
      trip("x9", 1, "sun", 9 * H),
    ]),
    calendar: {
      calendar: [
        {
          serviceId: "wk",
          days: [true, true, true, true, true, false, false],
          start: serviceDate("20260901"),
          end: serviceDate("20261231"),
        },
        {
          serviceId: "sun",
          days: [false, false, false, false, false, false, true],
          start: serviceDate("20260901"),
          end: serviceDate("20261231"),
        },
      ],
      exceptions: [],
    },
    corridors: [
      {
        coords: [
          [-123.1, 49.25],
          [-123.08625, 49.25],
        ],
        refs: [[1, 1, 0]],
      },
      {
        coords: [
          [-123.08625, 49.25],
          [-123.0725, 49.25],
        ],
        refs: [[1, 1, 1000]],
      },
    ],
  };
}

/** A plan published and read back from memory. */
async function roundTrip(plan: ServicePlan) {
  const { core, files } = publishPlan(plan);
  // Through JSON, as on disk.
  const json = new Map([...files].map(([k, v]) => [k, JSON.stringify(v)]));
  const parsed = JSON.parse(JSON.stringify(core)) as typeof core;
  const read = async (path: string) => JSON.parse(json.get(path)!) as unknown;
  return { core: parsed, files: json, plan: await assemblePlan(parsed, read) };
}

describe("published plans", () => {
  it("read back as they were written", async () => {
    const plan = fixture();
    const { plan: back } = await roundTrip(plan);
    const { corridors, ...rest } = back;
    const { corridors: _c, ...want } = plan;
    // Routes gain their weekday figures.
    expect(rest).toEqual({
      ...want,
      routes: want.routes.map((r) => ({
        ...r,
        weekdayWait: expect.any(Number),
      })),
      frequency: expect.any(Object),
    });
    // Corridors keep their geometry and gain their combos in place of their refs.
    expect(corridors!.map((c) => c.coords)).toEqual(
      plan.corridors!.map((c) => c.coords),
    );
    expect(corridors!.map((c) => c.combo)).toEqual([
      ...new CorridorFrequency(plan).combosOfCorridors(plan.corridors!),
    ]);
  });

  it("read back without their trips for drawing, keeping each pattern's start times", async () => {
    const plan = fixture();
    const { core, files } = await roundTrip(plan);
    const read = async (path: string) =>
      JSON.parse(files.get(path)!) as unknown;
    const lines = await assemblePlan(core, read, { trips: false });
    expect(lines.trips).toEqual([]);
    expect(lines.shapes).toEqual(plan.shapes);
    expect(lines.corridors!.map((c) => c.coords)).toEqual(
      plan.corridors!.map((c) => c.coords),
    );
    expect(lines.patterns.map((p) => p.starts)).toEqual([
      { wk: [6 * H, 23.5 * H] },
      { sun: [9 * H], wk: [8 * H, 8 * H + 600, 24.5 * H] },
    ]);
  });

  it("keep a service's late trips (and every SkyTrain trip) in a file of their own", async () => {
    const { core } = await roundTrip(fixture());
    const files = core.files.trips.map((f) => [f.path, f.trips]);
    expect(files).toEqual([
      ["trips/sun.json", 1],
      ["trips/wk.json", 2],
      ["trips/wk.late.json", 3],
    ]);
    const wk = new Set(["wk"]);
    // The day itself needs both; the day after, from midnight on, only the late file.
    expect(tripFilesFor(core.files, wk, 0).map((f) => f.path)).toEqual([
      "trips/wk.json",
      "trips/wk.late.json",
    ]);
    expect(
      tripFilesFor(core.files, wk, 24 * H + 60).map((f) => f.path),
    ).toEqual(["trips/wk.late.json"]);
    expect(tripFilesFor(core.files, wk, Infinity)).toEqual([]);
    // Track-level playback needs every SkyTrain trip of a service: all in its late file.
    expect(railTripFiles(core.files, wk).map((f) => f.path)).toEqual([
      "trips/wk.late.json",
    ]);
  });

  it("carry each pattern's start times for frequencies without the trips", async () => {
    const { core } = await roundTrip(fixture());
    const plan = decodeCore(core);
    expect(plan.trips).toEqual([]);
    expect(plan.patterns.map((p) => p.starts)).toEqual([
      { wk: [6 * H, 23.5 * H] },
      { sun: [9 * H], wk: [8 * H, 8 * H + 600, 24.5 * H] },
    ]);
  });

  it("decode their parts one by one", async () => {
    const plan = fixture();
    const { core, files } = await roundTrip(plan);
    const get = <T>(path: string) => JSON.parse(files.get(path)!) as T;
    expect(decodeShapes(get<PublishedShapes>(core.files.shapes))).toEqual(
      plan.shapes,
    );
    expect(
      decodeCorridors(get<PublishedCorridors>(core.files.corridors!)).map(
        (c) => c.coords,
      ),
    ).toEqual(plan.corridors!.map((c) => c.coords));
    const late = decodeTrips(get<PublishedTrips>("trips/wk.late.json"));
    expect(late.map((t) => t.id).sort()).toEqual(["101", "102", "203"]);
    // Ids that aren't plain numbers are kept as they are.
    expect(
      decodeTrips(get<PublishedTrips>("trips/wk.json")).map((t) => t.block),
    ).toEqual(["b-1", "b-1"]);
  });

  it("place vehicles the same when their trips are added by service", async () => {
    const plan = fixture();
    const { core, files } = await roundTrip(plan);
    const full = preparePlan(plan, kin);
    let pp = preparePlan({ ...decodeCore(core), shapes: plan.shapes }, kin);
    for (const service of ["wk", "sun"]) {
      const trips = core.files.trips
        .filter((f) => f.service === service)
        .flatMap((f) =>
          decodeTrips(JSON.parse(files.get(f.path)!) as PublishedTrips),
        );
      pp = withServiceTrips(pp, new Map([[service, trips]]), kin);
    }
    for (const [date, sec] of [
      ["20261021", 8 * H + 200],
      ["20261021", 8 * H + 450],
      ["20261021", 23.5 * H + 100],
      ["20261021", 24.5 * H + 100],
      ["20261025", 9 * H + 60],
    ] as const) {
      const q = { serviceDate: serviceDate(date), sec };
      expect(scheduledVehicles(pp, q)).toEqual(scheduledVehicles(full, q));
    }
  });
});

describe("line coding", () => {
  it("keeps coordinates at its decimals exactly", () => {
    const line: [number, number][] = [
      [-123.12345, 49.28765],
      [-123.12344, 49.28766],
      [-122.9, 49.1],
    ];
    expect(decodeLine(encodeLine(line, 5), 5)).toEqual(line);
    expect(encodeLine(line, 5).slice(2)).toEqual([1, 1, 22344, -18766]);
  });
});

describe("corridor metadata", () => {
  it("carries each corridor's combo and short neighbours", async () => {
    const plan = fixture();
    const { core, files } = await roundTrip(plan);
    const info = decodeCorridorInfo(
      JSON.parse(files.get(core.files.corridorInfo!)!) as PublishedCorridorInfo,
    );
    const combos = [
      ...new CorridorFrequency(plan).combosOfCorridors(plan.corridors!),
    ];
    // Without overview corridors, both sets are the detailed ones.
    for (const set of [info.detailed, info.overview])
      expect(set).toEqual({ combo: combos, short: [] });
  });

  it("publishes patterns' paths in their route group's file, each pass in order", async () => {
    const plan = fixture();
    // Pattern 1 (route 9) along both corridors, then back along the first.
    const detailed: PathStep[] = [
      [0, 0, 1000],
      [1, 1000, 2000],
      [0, 2000, 3000],
    ];
    plan.paths = new Map([[1, { detailed, overview: detailed.slice(0, 2) }]]);
    const { core, files } = await roundTrip(plan);
    expect(Object.keys(core.files.paths!)).toEqual(["9"]);
    expect(core).not.toHaveProperty("paths");
    const paths = decodePatternPaths(
      JSON.parse(files.get(core.files.paths!["9"]!)!) as PublishedPatternPaths,
    );
    expect(paths.get(1)).toEqual({ detailed, overview: detailed.slice(0, 2) });
  });
});

describe("plan tiles", () => {
  it("number corridors as the plan does, at the zooms each set is drawn", () => {
    const plan = fixture();
    const features = planTileFeatures(plan);
    const layer = (name: string) =>
      features.filter((f) => f.tippecanoe.layer === name);
    expect(layer(PLAN_TILE_LAYERS.corridors).map((f) => f.id)).toEqual([0, 1]);
    expect(layer(PLAN_TILE_LAYERS.corridors).map((f) => f.geometry)).toEqual(
      plan.corridors!.map((c) => ({
        type: "LineString",
        coordinates: c.coords,
      })),
    );
    expect(layer(PLAN_TILE_LAYERS.corridors)[0]!.tippecanoe.minzoom).toBe(14);
    expect(
      layer(PLAN_TILE_LAYERS.overviewCorridors)[0]!.tippecanoe.maxzoom,
    ).toBe(13);
  });

  it("draw buses as corridors, and other routes along their shapes", () => {
    const routes = planTileFeatures(fixture()).filter(
      (f) => f.tippecanoe.layer === PLAN_TILE_LAYERS.routes,
    );
    expect(routes.map((f) => f.properties["route"])).toEqual(["expo"]);
    expect(routes[0]!.properties).toMatchObject({
      kind: "skytrain",
      color: "#0033a0",
    });
  });

  it("draw SkyTrain from its track where the region has it", () => {
    const features = planTileFeatures(fixture(), {
      tracks: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: {
              type: "segment",
              id: "w1.0",
              kind: "yard",
              lines: [],
            },
            geometry: {
              type: "LineString",
              coordinates: [
                [-123.1, 49.26],
                [-123.09, 49.26],
              ],
            },
          },
        ],
      } as never,
      lines: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: {
              type: "centre",
              line: "expo",
              lines: ["expo"],
              shared: false,
            },
            geometry: {
              type: "LineString",
              coordinates: [
                [-123.1, 49.25],
                [-123.0725, 49.25],
              ],
            },
          },
        ],
      },
    });
    const of = (name: string) =>
      features.filter((f) => f.tippecanoe.layer === name);
    // Not along its GTFS shape too.
    expect(of(PLAN_TILE_LAYERS.routes)).toEqual([]);
    expect(of(PLAN_TILE_LAYERS.railLines)[0]!.properties).toEqual({
      type: "centre",
      line: "expo",
      shared: false,
      color: "#0033a0",
    });
    // Yard track has no line colour (the map draws it grey).
    expect(of(PLAN_TILE_LAYERS.railTracks)[0]!.properties).toEqual({
      kind: "yard",
      line: "",
    });
  });
});
