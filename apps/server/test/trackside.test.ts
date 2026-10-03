// Trackside camera uploads through the admin API, stored as files (no database).

import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RtService } from "../src/rt/service.ts";
import { Auth } from "../src/auth.ts";
import { createApp } from "../src/app.ts";
import { readEnv } from "../src/env.ts";
import { FileTracksideStore } from "../src/trackside.ts";
import type { PassReport } from "@transitopia/trackside/types.ts";

const jpeg = `data:image/jpeg;base64,${btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0, 1, 2, 3))}`;
const report = (patch: Partial<PassReport> = {}): PassReport => ({
  id: "3f2c9a1e-0000-4000-8000-000000000001",
  setup: {
    id: "8a1b2c3d-0000-4000-8000-000000000002",
    at: [-123.1008, 49.27295],
    lines: ["expo"],
    tracks: [{ segment: "w1.0", distanceM: 37, kind: "main", lines: ["expo"] }],
    rightwardBearing: 110,
    hfovDeg: 65,
    frameWidth: 1920,
  },
  start: "2026-10-01T22:44:40.000Z",
  end: "2026-10-01T22:44:47.000Z",
  track: 0,
  trackSegment: "w1.0",
  extent: [0.2, 0.7],
  screen: "right",
  bearing: 110,
  speedKmh: 62,
  pxPerS: 1700,
  occluded: false,
  cars: [{ number: "317", confidence: 0.99, reads: 2, crop: jpeg }],
  uncertain: [{ number: "35", confidence: 0.7, reads: 1, crop: jpeg }],
  source: "camera",
  ...patch,
});

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("trackside passes", () => {
  it("stores uploads once, lists them and serves their crops, for admins only", async () => {
    dir = await mkdtemp(join(tmpdir(), "trackside-"));
    const env = readEnv({ ADMIN_DEV_TOKEN: "dev-token" });
    const service = new RtService({
      historyDir: dir,
      record: false,
      log: () => {},
      apiKey: null,
      aisApiKey: null,
      dispatch: false,
      disruptionsDir: dir,
    });
    const app = createApp({
      service,
      auth: new Auth(undefined, env),
      env,
      trackside: new FileTracksideStore(dir),
    });
    const call = (path: string, init: RequestInit = {}, token = "dev-token") =>
      app.request(path, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });
    const post = (body: unknown, token?: string) =>
      call(
        "/admin/api/trackside/passes",
        { method: "POST", body: JSON.stringify(body) },
        token,
      );

    expect((await post(report(), "wrong")).status).toBe(401);
    expect((await post(report({ source: "file" }))).status).toBe(400);
    expect(await (await post(report())).json()).toEqual({
      ok: true,
      result: "added",
    });
    // Sent again (e.g. with its track corrected): replaced, crops kept.
    expect(await (await post(report({ track: undefined }))).json()).toEqual({
      ok: true,
      result: "updated",
    });

    const { passes } = (await (
      await call("/admin/api/trackside/passes")
    ).json()) as {
      passes: {
        id: string;
        createdBy: string;
        report: { cars: { number: string; crop?: string }[] };
        crops: unknown[];
      }[];
    };
    expect(passes).toHaveLength(1);
    expect(passes[0]).toMatchObject({ id: report().id, createdBy: "dev" });
    // Crops are stored separately, not in the report.
    expect(passes[0]!.report.cars).toEqual([
      { number: "317", confidence: 0.99, reads: 2 },
    ]);
    expect(passes[0]!.crops).toEqual([
      { idx: 0, reading: "317", confidence: 0.99, accepted: true, label: null },
      { idx: 1, reading: "35", confidence: 0.7, accepted: false, label: null },
    ]);
    const crop = await call(`/admin/api/trackside/crops/${report().id}/1`);
    expect(crop.headers.get("Content-Type")).toBe("image/jpeg");
    expect(new Uint8Array(await crop.arrayBuffer()).slice(0, 2)).toEqual(
      new Uint8Array([0xff, 0xd8]),
    );
    expect((await call(`/admin/api/trackside/crops/..%2Fx/0`)).status).toBe(
      404,
    );
    service.stop();
  });
});
