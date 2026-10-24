import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlacesIndex } from "@transitopia/shared/features.ts";
import {
  buildPlaces,
  decodeRegistry,
  encodeRegistry,
  writePlaces,
  type Registry,
} from "../src/features.ts";

const feature = (
  id: string,
  kind: Registry["features"][number]["kind"],
  name: string,
  more: Partial<Registry["features"][number]> = {},
): Registry["features"][number] => ({
  t: "feature",
  id,
  kind,
  name,
  lon: -123,
  lat: 49,
  parent: null,
  status: "active",
  mergedInto: null,
  operator: null,
  feed: null,
  ...more,
});
const ref = (
  feature: string,
  scheme: string,
  value: string,
  from: number,
  to: number,
): Registry["refs"][number] => ({
  t: "ref",
  feature,
  scheme,
  namespace: "translink",
  ref: value,
  from,
  to,
});

const registry: Registry = {
  versions: [1, 2].map((seq) => ({
    t: "version",
    feed: "translink",
    version: `V${seq}`,
    seq,
    start: "2026-10-01",
    end: "2026-12-31",
    sha256: "x",
    bytes: 1,
  })),
  features: [
    feature("sn-00000001", "station", "Waterfront"),
    feature("ex-00000002", "exchange", "UBC Exchange"),
    feature("st-00000003", "stop", "Waterfront Station @ Platform 1", {
      parent: "sn-00000001",
    }),
    feature("st-00000004", "stop", "UBC Exchange @ Bay 1", {
      parent: "ex-00000002",
    }),
    feature("st-00000005", "stop", "UBC Exchange @ Bay 2 (old)", {
      status: "merged",
      mergedInto: "st-00000004",
    }),
    feature("rt-00000006", "route", "99", { lon: null, lat: null }),
  ],
  refs: [
    ref("sn-00000001", "gtfs-stop", "12034", 1, 3),
    ref("st-00000003", "gtfs-stop", "11001", 1, 3),
    ref("st-00000004", "gtfs-stop", "13001", 1, 3),
    ref("st-00000004", "stop", "60001", 1, 3),
    ref("rt-00000006", "gtfs-route", "6612", 1, 2),
    ref("rt-00000006", "gtfs-route", "7000", 2, 3),
  ],
};

const plan = (route: string) => ({
  stations: [
    { id: "12034", name: "Waterfront", lon: -123, lat: 49, routes: [] },
  ],
  stops: [
    {
      id: "11001",
      name: "Waterfront Station @ Platform 1",
      lon: -123,
      lat: 49,
    },
    {
      id: "13001",
      name: "UBC Exchange @ Bay 1",
      lon: -123,
      lat: 49,
      code: "60001",
    },
  ],
  routes: [
    {
      key: "99",
      label: "99",
      kind: "bus" as const,
      mode: "bus" as const,
      brand: false,
      color: "#000",
      textColor: "#fff",
      gtfsRouteId: route,
    },
  ],
});

describe("places files", () => {
  const dirs: string[] = [];
  afterAll(() => Promise.all(dirs.map((d) => rm(d, { recursive: true }))));

  it("give the registry's keys for a version's plan ids", () => {
    const p = buildPlaces(registry, plan("7000"), "translink", "V2")!;
    expect(p.stations).toEqual({ "12034": "sn-00000001-waterfront" });
    expect(p.stops).toEqual({
      "11001": "st-00000003-waterfront-station-platform-1",
      // A stop's suffix is its code.
      "13001": "st-00000004-60001",
    });
    expect(p.routes).toEqual({ "99": "rt-00000006-99" });
    expect(p.parents).toEqual({
      "11001": "sn-00000001",
      "13001": "ex-00000002",
    });
    expect(Object.keys(p.places).sort()).toEqual([
      "ex-00000002",
      "sn-00000001",
    ]);
    expect(p.redirects).toEqual({ "st-00000005": "st-00000004" });
    // V1's route_id was 6612: 7000 names nothing there.
    expect(
      buildPlaces(registry, plan("7000"), "translink", "V1")!.routes,
    ).toEqual({});
    expect(
      buildPlaces(registry, plan("7000"), "translink", "V9"),
    ).toBeUndefined();
  });

  it("are numbered anew only when their content changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "places-"));
    dirs.push(root);
    const p = buildPlaces(registry, plan("7000"), "translink", "V2")!;
    expect(await writePlaces(p, root)).toBe(true);
    expect(await writePlaces(p, root)).toBe(false);
    const renamed = structuredClone(p);
    renamed.stations["12034"] = "sn-00000001-waterfront-hub";
    expect(await writePlaces(renamed, root)).toBe(true);
    const index = JSON.parse(
      await readFile(join(root, "data/feeds/translink/places.json"), "utf8"),
    ) as PlacesIndex;
    expect(index.versions).toEqual({
      V2: "data/feeds/translink/V2/places.2.json",
    });
  });

  it("round-trip the export format", () => {
    expect(decodeRegistry(encodeRegistry(registry))).toEqual(registry);
  });
});
