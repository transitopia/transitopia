import { afterEach, describe, expect, it } from "vitest";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RtService } from "../src/rt/service.ts";
import { moveDispatchHistory } from "../src/rt/dispatch.ts";
import type { CorrectionsRepo } from "../src/corrections.ts";
import type { LiveTransitResponse } from "@transitopia/transit-core/rt/live.ts";

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
  it("serves a network's dispatch under /networks/<id>/ and /rt/dispatch, and in the live endpoint of regions showing its feed", async () => {
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
      regions: [
        { id: "metro-vancouver", feeds: ["translink"] },
        { id: "elsewhere", feeds: ["bc-transit-victoria"] },
      ],
    });
    const get = (p: string) => service.handle(p, new URLSearchParams());
    for (const p of ["/networks/skytrain/dispatch", "/rt/dispatch"]) {
      const r = await get(p);
      expect(r.status, p).toBe(200);
      expect(JSON.parse(String(r.body))).toEqual({ schema: 1, byDate: {} });
    }
    expect((await get("/networks/elsewhere/dispatch")).status).toBe(404);
    expect(
      (await get("/networks/skytrain/dispatch/20260928/abc.json")).status,
    ).toBe(404);
    const live = async (region: string) =>
      JSON.parse(
        String((await get(`/regions/${region}/live/transit`)).body),
      ) as LiveTransitResponse;
    expect((await live("metro-vancouver")).sources["dispatch"]).toEqual({
      kind: "dispatch",
      versions: {},
    });
    expect((await live("elsewhere")).sources["dispatch"]).toBeUndefined();
  });

  it("moves versions kept before they were a network's into its directory", async () => {
    dir = await mkdtemp(join(tmpdir(), "dispatch-history-"));
    await mkdir(join(dir, "20260928"));
    await writeFile(join(dir, "20260928", "a.json"), "a");
    await writeFile(join(dir, "20260928", "b.json"), "b");
    // Some of the date's versions already moved.
    await mkdir(join(dir, "skytrain", "20260928"), { recursive: true });
    await writeFile(join(dir, "skytrain", "20260928", "c.json"), "c");
    const logs: string[] = [];
    await moveDispatchHistory("skytrain", (m) => logs.push(m), dir);
    expect((await readdir(dir)).sort()).toEqual(["skytrain"]);
    expect((await readdir(join(dir, "skytrain", "20260928"))).sort()).toEqual([
      "a.json",
      "b.json",
      "c.json",
    ]);
    expect(
      await readFile(join(dir, "skytrain", "20260928", "a.json"), "utf8"),
    ).toBe("a");
    expect(logs).toEqual(["moved 1 dates of dispatch versions into skytrain/"]);
    // Again, nothing to move.
    await moveDispatchHistory("skytrain", (m) => logs.push(m), dir);
    expect(logs).toHaveLength(1);
  });
});
