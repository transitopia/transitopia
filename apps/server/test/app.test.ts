import { describe, expect, it } from "vitest";
import type { Disruption } from "@transitopia/transit-core/disruption/types.ts";
import {
  createApp,
  diskCheck,
  disruptionProblems,
  type AppDeps,
} from "../src/app.ts";

const disruption = (active: Disruption["active"]): Disruption =>
  ({
    id: "d1",
    text: "Single tracking",
    source: "test",
    active,
    headway: [{ line: "Canada Line", minS: 600 }],
  }) as Disruption;

describe("disruptionProblems", () => {
  it("accepts periods with an offset or Z", () => {
    expect(
      disruptionProblems(
        disruption([
          {
            from: "2026-09-27T21:00:00-07:00",
            until: "2026-09-28T02:00:00-07:00",
          },
          {
            from: "2026-09-29T04:00:00.000Z",
            until: "2026-09-29T11:00:00.000Z",
          },
        ]),
        "d1",
      ),
    ).toEqual([]);
  });

  it("refuses times without an offset, other formats and empty ranges", () => {
    for (const [from, until] of [
      ["2026-09-27T21:00", "2026-09-28T02:00"],
      ["Sep 27 2026 21:00 PDT", "Sep 28 2026 02:00 PDT"],
      ["2026-09-28T02:00:00-07:00", "2026-09-27T21:00:00-07:00"],
    ] as const)
      expect(disruptionProblems(disruption([{ from, until }]), "d1")).toEqual([
        `period ${from} → ${until} is not a valid range of ISO 8601 times with offset`,
      ]);
  });
});

describe("the real-time API", () => {
  it("routes /rt/* and /regions/*, and answers a matching If-None-Match with a 304", async () => {
    const paths: string[] = [];
    const service = {
      handle: async (path: string) => {
        paths.push(path);
        return {
          status: 200,
          headers: { ETag: 'W/"abc123"', "Cache-Control": "public, max-age=5" },
          body: "{}",
        };
      },
    };
    const app = createApp({
      service,
      auth: {},
      env: { allowedOrigins: [] },
    } as unknown as AppDeps);
    const full = await app.request("/regions/r/live/transit");
    expect(full.status).toBe(200);
    expect(await full.text()).toBe("{}");
    // As it comes back through a proxy that compressed the body.
    const same = await app.request("/regions/r/live/transit", {
      headers: { "If-None-Match": 'W/"abc123-gzip"' },
    });
    expect(same.status).toBe(304);
    expect(same.headers.get("Cache-Control")).toBe("public, max-age=5");
    const changed = await app.request("/rt/status", {
      headers: { "If-None-Match": 'W/"def456"' },
    });
    expect(changed.status).toBe(200);
    expect(paths).toEqual([
      "/regions/r/live/transit",
      "/regions/r/live/transit",
      "/rt/status",
    ]);
  });
});

describe("diskCheck", () => {
  // The VM on 2026-10-25 (df -h: 96G size, 25G used, 72G available, 26 %), in 4 KiB blocks.
  const vm = {
    bsize: 4096,
    blocks: 25_165_824,
    bfree: 18_612_224,
    bavail: 18_612_224,
  };

  it("reports use as df does", () => {
    expect(diskCheck(vm, 0.85)).toEqual({
      ok: true,
      detail: "26 % used, 71.0 GiB free of 96.0 GiB (limit 85 %)",
    });
  });

  it("counts blocks reserved for root as unavailable, and fails past the limit", () => {
    // 80 % of the blocks used, and 5 % more reserved: 84 % of what's usable.
    const blocks = 1_000_000;
    const c = { bsize: 4096, blocks, bfree: 200_000, bavail: 150_000 };
    expect(diskCheck(c, 0.85).ok).toBe(true);
    expect(diskCheck(c, 0.8).ok).toBe(false);
  });
});

describe("the feature resolver", () => {
  const app = createApp({
    service: { handle: async () => ({ status: 404, headers: {}, body: "" }) },
    auth: {},
    env: { allowedOrigins: [] },
    cycling: async (key: string) =>
      key === "osm-way:10" ?
        {
          key: "osm-way:9",
          kind: "cycling-way",
          name: "Seaside",
          centroid: [-123.1, 49.26],
          bbox: [-123.1, 49.25, -123.1, 49.27],
        }
      : undefined,
  } as unknown as AppDeps);

  it("answers an OSM ref from the cycling map without a registry", async () => {
    const r = await app.request("/features/osm-way:10");
    expect(r.status).toBe(200);
    expect(r.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await r.json()).toEqual({
      unminted: true,
      key: "osm-way:9",
      kind: "cycling-way",
      name: "Seaside",
      centroid: [-123.1, 49.26],
      bbox: [-123.1, 49.25, -123.1, 49.27],
      refs: ["osm-way:10"],
    });
    const unknown = await app.request("/features/osm-way:11");
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ unminted: true });
  });

  it("needs the registry for everything else", async () => {
    expect((await app.request("/features/sn-k3v9qd7m")).status).toBe(503);
  });
});
