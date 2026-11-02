import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RtService } from "../src/rt/service.ts";
import type { CorrectionsRepo } from "../src/corrections.ts";

const RAIL = { network: "skytrain", feed: "translink" };
/** No corrections: the dispatcher has nothing to dispatch, so its index stays empty. */
const NO_CORRECTIONS = {
  load: async () => ({ observations: [], disruptions: [] }),
} as unknown as CorrectionsRepo;

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("live dispatch by rail network", () => {
  it("serves a network's dispatch under /networks/<id>/, live and as an index", async () => {
    dir = await mkdtemp(join(tmpdir(), "rt-dispatch-"));
    const service = new RtService({
      historyDir: dir,
      record: false,
      poll: false,
      log: () => {},
      apiKey: null,
      aisApiKey: null,
      rail: RAIL,
      corrections: NO_CORRECTIONS,
      dispatch: {
        net: RAIL,
        corrections: NO_CORRECTIONS,
        historyDir: join(dir, "dispatch"),
        log: () => {},
      },
    });
    const get = (p: string) => service.handle(p, new URLSearchParams());
    const r = await get("/networks/skytrain/dispatch");
    expect(r.status).toBe(200);
    expect(JSON.parse(String(r.body))).toEqual({ schema: 1, byDate: {} });
    expect((await get("/networks/elsewhere/dispatch")).status).toBe(404);
    // The pre-network endpoint is gone.
    expect((await get("/rt/dispatch")).status).toBe(404);
    expect(
      (await get("/networks/skytrain/dispatch/20260928/abc.json")).status,
    ).toBe(404);
    const lr = await get("/networks/skytrain/live/dispatch");
    expect(lr.headers["Cache-Control"]).toMatch(/^public, max-age=\d+$/);
    expect(JSON.parse(String(lr.body))).toEqual({
      schema: 1,
      nextAt: null,
      sources: { dispatch: { kind: "dispatch", versions: {} } },
    });
    expect((await get("/networks/elsewhere/live/dispatch")).status).toBe(404);
    expect((await get("/networks/skytrain/live/nothing")).status).toBe(404);
  });
});
