import { describe, expect, it } from "vitest";
import { createApp, diskCheck, type AppDeps } from "../src/app.ts";

describe("the real-time API", () => {
  it("routes /rt/*, /feeds/* and /networks/*, and answers a matching If-None-Match with a 304", async () => {
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
    const full = await app.request("/feeds/f/live");
    expect(full.status).toBe(200);
    expect(await full.text()).toBe("{}");
    // As it comes back through a proxy that compressed the body.
    const same = await app.request("/feeds/f/live", {
      headers: { "If-None-Match": 'W/"abc123-gzip"' },
    });
    expect(same.status).toBe(304);
    expect(same.headers.get("Cache-Control")).toBe("public, max-age=5");
    const changed = await app.request("/rt/status", {
      headers: { "If-None-Match": 'W/"def456"' },
    });
    expect(changed.status).toBe(200);
    await app.request("/networks/n/live/dispatch");
    expect(paths).toEqual([
      "/feeds/f/live",
      "/feeds/f/live",
      "/rt/status",
      "/networks/n/live/dispatch",
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
