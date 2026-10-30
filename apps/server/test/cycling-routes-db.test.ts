// Bike routes in PostgreSQL: loading a build's routes, their `cr` IDs (minted once, renamed with
// OSM, retired and back), a route card's data with its nesting, and the resolver's extent. Skipped
// without TEST_DATABASE_URL (infra/compose.dev.yml).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestDb,
  TEST_DATABASE_URL,
  type TestDb,
} from "@transitopia/db/testing.ts";
import type {
  CyclingRoute,
  CyclingRoutesFile,
} from "@transitopia/cycling-core/routes.ts";
import { parseKey } from "@transitopia/shared/features.ts";
import {
  cyclingRouteDetail,
  loadCyclingRoutes,
} from "../src/features/cycling-routes.ts";
import { findFeature, resolveKey } from "../src/features/registry.ts";

const route = (more: Partial<CyclingRoute>): CyclingRoute => ({
  lengthM: 1000,
  comfortM: [100, 0, 200, 300, 400],
  bbox: [-123.2, 49.2, -123.1, 49.3],
  ...more,
});

let built = 0;
/** A build of BC's routes: CVG contains its Vancouver part, which a loop of two contains too. */
const build = (
  routes: Record<string, CyclingRoute> = {
    "1": route({
      name: "Central Valley Greenway",
      ref: "CVG",
      network: "rcn",
      subroutes: [2],
    }),
    "2": route({ name: "CVG (Vancouver)", parents: [1, 3], ferryM: 250 }),
    "3": route({ ref: "LP", subroutes: [2, 4], parents: [4] }),
    "4": route({ name: "Loop", subroutes: [3], parents: [3] }),
  },
): CyclingRoutesFile => ({
  area: "british-columbia",
  osm: { file: "2026-10-28-x.opl.gz", timestamp: "2026-10-28T00:00:00Z" },
  builtAt: new Date(Date.UTC(2026, 9, 28, 0, 0, ++built)).toISOString(),
  routes,
});

describe.skipIf(!TEST_DATABASE_URL)("bike routes", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(() => t?.drop());

  it("loads a build and mints an ID for each route, once", async () => {
    const file = build();
    expect(await loadCyclingRoutes(t.db, file)).toEqual({
      loaded: true,
      routes: 4,
      minted: 4,
      renamed: 0,
      reactivated: 0,
      retired: 0,
    });
    // The same build again isn't loaded again, but the registry is still reconciled.
    expect(await loadCyclingRoutes(t.db, file)).toMatchObject({
      loaded: false,
      minted: 0,
    });
    expect(await loadCyclingRoutes(t.db, build())).toMatchObject({
      loaded: true,
      minted: 0,
    });
    const f = (await findFeature(t.db, "osm-relation:1"))!;
    expect(f).toMatchObject({
      kind: "cycling-route",
      name: "Central Valley Greenway",
    });
    expect(parseKey(f.id)).toMatchObject({ form: "id", kind: "cycling-route" });
  });

  it("answers a route card with its nesting, by ID or ref", async () => {
    const f = (await findFeature(t.db, "osm-relation:2"))!;
    const d = (await cyclingRouteDetail(t.db, `${f.id}-anything`))!;
    expect(d).toMatchObject({
      key: `${f.id}-cvg-vancouver`,
      osmRelation: 2,
      name: "CVG (Vancouver)",
      lengthM: 1000,
      comfortM: [100, 0, 200, 300, 400],
      ferryM: 250,
      bbox: [-123.2, 49.2, -123.1, 49.3],
      subroutes: [],
    });
    expect(d.parents.map((p) => p.osmRelation)).toEqual([1, 3]);
    // Nearest first, each once, through the loop.
    expect(d.ancestors.map((p) => p.osmRelation)).toEqual([1, 3, 4]);
    // A route with no name is named by its ref.
    expect(d.parents[1]).toMatchObject({ name: "LP", network: null });

    const cvg = (await cyclingRouteDetail(t.db, "osm-relation:1"))!;
    expect(cvg).toMatchObject({ name: "Central Valley Greenway", ref: "CVG" });
    expect(cvg.subroutes.map((s) => s.osmRelation)).toEqual([2]);
    expect(cvg.parents).toEqual([]);
    expect(await cyclingRouteDetail(t.db, "osm-way:1")).toBeUndefined();
    expect(await cyclingRouteDetail(t.db, "osm-relation:99")).toBeUndefined();
  });

  it("gives the resolver a route's extent", async () => {
    const r = await resolveKey(t.db, "osm-relation:1");
    expect(r).toMatchObject({
      kind: "cycling-route",
      bbox: [-123.2, 49.2, -123.1, 49.3],
      centroid: [-123.15, 49.25],
      refs: ["osm-relation:1"],
    });
  });

  it("follows OSM's names, and retires routes that leave it until they're back", async () => {
    const id = (await findFeature(t.db, "osm-relation:1"))!.id;
    expect(
      await loadCyclingRoutes(
        t.db,
        build({ "1": route({ name: "CVG" }), "2": route({ name: "Part" }) }),
      ),
    ).toMatchObject({ minted: 0, renamed: 2, retired: 2 });
    expect((await findFeature(t.db, id))!.name).toBe("CVG");
    expect(await cyclingRouteDetail(t.db, "osm-relation:3")).toBeUndefined();
    // Its parent left with the build: no parents now.
    expect((await cyclingRouteDetail(t.db, "osm-relation:2"))!.parents).toEqual(
      [],
    );
    expect(await loadCyclingRoutes(t.db, build())).toMatchObject({
      minted: 0,
      reactivated: 2,
      retired: 0,
    });
    expect((await findFeature(t.db, "osm-relation:3"))!.status).toBe("active");
  });
});
