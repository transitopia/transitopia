import { afterEach, describe, expect, it, vi } from "vitest";
import { parseConfig, parseFeed } from "@transitopia/transit-core/config.ts";
import { serviceDate } from "@transitopia/transit-core/time.ts";
import kinematics from "@transitopia/config/defaults/kinematics.json";
import victoria from "@transitopia/config/feeds/bc-transit-victoria/feed.json";
import { publishPlan } from "@transitopia/transit-core/plan/published.ts";
import type { ServicePlan } from "@transitopia/transit-core/plan/types.ts";
import { PlanStore } from "../src/plans.ts";

const config = {
  kinematics: parseConfig("kinematics", { ...kinematics, routes: {} }),
  operations: undefined,
  feed: parseFeed(victoria),
};
const manifest = (generatedAt: string) => ({
  schema: 1,
  generatedAt,
  feeds: [
    {
      version: "v1",
      start: "20260901",
      end: "20261231",
      path: "data/feeds/bc-transit-victoria/v1/plan.json",
      builtAt: "2026-10-18T10:00:00.000Z",
    },
  ],
});

/** A PlanStore over a stubbed fetch; returns it and every URL requested after the manifest. */
async function store(generatedAt: string) {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      urls.push(url);
      return url.endsWith("manifest.json") ?
          new Response(JSON.stringify(manifest(generatedAt)))
        : new Response("", { status: 404 });
    }),
  );
  const s = await PlanStore.load(
    "https://data.example/",
    undefined,
    "greater-victoria",
    config,
  );
  urls.length = 0;
  return { s, urls };
}

describe("PlanStore data URLs", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("names the build in every published file's URL", async () => {
    const { s, urls } = await store("2026-10-18T17:33:18.203Z");
    expect(s.dataUrl("data/regions/x/infra/tracks.geojson")).toBe(
      "https://data.example/data/regions/x/infra/tracks.geojson?v=2026-10-18T17%3A33%3A18.203Z",
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    s.planFor(serviceDate("20261021"));
    expect(urls).toEqual([
      "https://data.example/data/feeds/bc-transit-victoria/v1/plan.json?v=2026-10-18T17%3A33%3A18.203Z",
    ]);
  });

  it("waits longer each time before retrying a plan that failed to load", async () => {
    const { s, urls } = await store("2026-10-18T17:33:18.203Z");
    vi.spyOn(console, "error").mockImplementation(() => {});
    let now = Date.parse("2026-10-21T08:00:00Z");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const date = serviceDate("20261021");
    /** Redraws: planFor on each, letting the failed load settle in between. */
    const redraws = async (n: number) => {
      for (let i = 0; i < n; i++) {
        s.planFor(date);
        await new Promise((r) => setTimeout(r, 0));
      }
    };
    await redraws(10);
    expect(urls).toHaveLength(1);
    now += 5_000;
    await redraws(10);
    expect(urls).toHaveLength(2);
    now += 5_000;
    await redraws(10);
    expect(urls).toHaveLength(2);
    now += 5_000;
    await redraws(10);
    expect(urls).toHaveLength(3);
  });

  it("changes the URLs when the data is rebuilt", async () => {
    const a = (await store("2026-10-17T10:39:00.000Z")).s.dataUrl("p.json");
    const b = (await store("2026-10-18T17:33:18.203Z")).s.dataUrl("p.json");
    expect(a).not.toBe(b);
  });
});

describe("PlanStore loading plans by parts", () => {
  afterEach(() => vi.unstubAllGlobals());

  const H = 3600;
  const trip = (id: string, service: string, start: number) => ({
    id,
    pattern: 0,
    service,
    headsign: "Downtown",
    start,
    arr: [0, 600],
  });
  const plan: ServicePlan = {
    schema: 1,
    feed: "bc-transit-victoria",
    feedVersion: "v1",
    feedStart: serviceDate("20260901"),
    feedEnd: serviceDate("20261231"),
    timezone: "America/Vancouver",
    builtAt: "",
    routes: [
      {
        key: "95",
        label: "95 Blink",
        kind: "bus",
        mode: "bus",
        color: "#0a0",
        textColor: "#fff",
        gtfsRouteId: "95",
      },
    ],
    stops: [
      { id: "A", name: "A", lon: -123.4, lat: 48.45 },
      { id: "B", name: "B", lon: -123.38, lat: 48.45 },
    ],
    stations: [],
    hubs: [],
    shapes: {
      s: [
        [-123.4, 48.45],
        [-123.38, 48.45],
      ],
    },
    patterns: [
      {
        id: 0,
        route: "95",
        direction: 0,
        shape: "s",
        stops: [0, 1],
        dist: [0, 1475],
      },
    ],
    trips: [
      trip("1", "wk", 8 * H),
      trip("2", "wk", 24.2 * H),
      trip("3", "sat", 9 * H),
    ],
    calendar: {
      calendar: [
        {
          serviceId: "wk",
          days: [true, true, true, true, true, false, false],
          start: serviceDate("20260901"),
          end: serviceDate("20261231"),
        },
        {
          serviceId: "sat",
          days: [false, false, false, false, false, true, false],
          start: serviceDate("20260901"),
          end: serviceDate("20261231"),
        },
      ],
      exceptions: [],
    },
  };

  /** A store over the plan's published files; returns it and the files requested after the manifest. */
  async function published() {
    const { core, files } = publishPlan(plan);
    const dir = "data/feeds/bc-transit-victoria/v1/";
    const served = new Map<string, unknown>([
      [`${dir}plan.json`, core],
      ...[...files].map(([k, v]): [string, unknown] => [dir + k, v]),
    ]);
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = url
          .replace("https://data.example/", "")
          .replace(/\?.*/, "");
        if (path.endsWith("manifest.json"))
          return new Response(JSON.stringify(manifest("2026-10-19T00:00:00Z")));
        urls.push(path.slice(dir.length));
        const body = served.get(path);
        return body ?
            new Response(JSON.stringify(body))
          : new Response("", { status: 404 });
      }),
    );
    const s = await PlanStore.load(
      "https://data.example/",
      undefined,
      "greater-victoria",
      config,
    );
    return { s, urls };
  }

  const settle = (s: PlanStore) =>
    new Promise<void>((resolve) => {
      const off = s.onChange(() => {
        off();
        resolve();
      });
    });

  it("loads the core, its shapes and the date's trips, then the day after's late trips only", async () => {
    const { s, urls } = await published();
    const tue = serviceDate("20261020");
    expect(s.planFor(tue)).toBeUndefined();
    await settle(s);
    // The core is in: the date's trips were asked for with it.
    expect(urls.sort()).toEqual([
      "plan.json",
      "shapes.json",
      "trips/wk.json",
      "trips/wk.late.json",
    ]);
    expect(s.planFor(tue, Infinity)?.tripIndex.size).toBe(0);
    while (!s.planFor(tue)) await settle(s);
    const pp = s.planFor(tue)!;
    expect([...pp.tripIndex.keys()].sort()).toEqual(["1", "2"]);
    expect(pp.plan.patterns[0]!.starts).toEqual({
      sat: [9 * H],
      wk: [8 * H, 24.2 * H],
    });

    // Saturday: its own trips; Friday's, from midnight on, are already in (late file).
    const sat = serviceDate("20261024");
    expect(s.planFor(serviceDate("20261023"), 24 * H + 60)).toBe(pp);
    urls.length = 0;
    expect(s.planFor(sat)).toBeUndefined();
    while (!s.planFor(sat)) await settle(s);
    expect(urls).toEqual(["trips/sat.json"]);
    expect(s.planFor(sat)!.plan).toBe(pp.plan);
  });
});
