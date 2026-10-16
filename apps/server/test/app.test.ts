import { describe, expect, it } from "vitest";
import type { Disruption } from "@transitopia/transit-core/disruption/types.ts";
import { createApp, disruptionProblems, type AppDeps } from "../src/app.ts";

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
