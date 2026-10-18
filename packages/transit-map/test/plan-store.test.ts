import { afterEach, describe, expect, it, vi } from "vitest";
import { parseConfig, parseFeed } from "@transitopia/transit-core/config.ts";
import { serviceDate } from "@transitopia/transit-core/time.ts";
import kinematics from "@transitopia/config/defaults/kinematics.json";
import victoria from "@transitopia/config/feeds/bc-transit-victoria/feed.json";
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

  it("changes the URLs when the data is rebuilt", async () => {
    const a = (await store("2026-10-17T10:39:00.000Z")).s.dataUrl("p.json");
    const b = (await store("2026-10-18T17:33:18.203Z")).s.dataUrl("p.json");
    expect(a).not.toBe(b);
  });
});
