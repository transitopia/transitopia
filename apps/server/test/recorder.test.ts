import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  RtSnapshot,
  RtVehicle,
} from "@transitopia/transit-core/rt/types.ts";
import { Recorder } from "../src/rt/recorder.ts";

const GAP = 75_000;
const bus: RtVehicle = {
  id: "1",
  routeKey: "r",
  lat: 49.28,
  lon: -123.1,
  ts: 0,
};
// 2026-10-23 08:00 local, polled every minute.
const t0 = Date.parse("2026-10-23T15:00:00Z");
const snap = (min: number, vehicles: RtVehicle[]): RtSnapshot => ({
  fetchedAt: t0 + min * 60_000,
  headerTs: t0 + min * 60_000,
  vehicles,
});

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "recorder-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Buses, then a feed answering with none for 10 minutes, then buses again. */
async function recordOutage(r: Recorder): Promise<void> {
  for (let m = 0; m <= 20; m++)
    await r.record(snap(m, m >= 5 && m < 15 ? [] : [bus]));
}

describe("Recorder coverage", () => {
  it("leaves empty GTFS-RT polls out of coverage (emptyIsGap)", () =>
    withDir(async (dir) => {
      const r = new Recorder(dir, GAP, { emptyIsGap: true });
      await recordOutage(r);
      expect(r.coverage()).toEqual([
        [t0, t0 + 4 * 60_000],
        [t0 + 15 * 60_000, t0 + 20 * 60_000],
      ]);
    }));

  it("covers empty batches by default (AIS: connected without fixes)", () =>
    withDir(async (dir) => {
      const r = new Recorder(dir, GAP);
      await recordOutage(r);
      expect(r.coverage()).toEqual([[t0, t0 + 20 * 60_000]]);
    }));

  it("rebuilds a missing coverage.json from the hour files", () =>
    withDir(async (dir) => {
      // Recorded by the AIS rule (the outage covered), then coverage.json deleted.
      await recordOutage(new Recorder(dir, GAP));
      await rm(join(dir, "coverage.json"));
      const r = new Recorder(dir, GAP, { emptyIsGap: true });
      await r.init();
      const expected = [
        [t0, t0 + 4 * 60_000],
        [t0 + 15 * 60_000, t0 + 20 * 60_000],
      ];
      expect(r.coverage()).toEqual(expected);
      expect(
        JSON.parse(await readFile(join(dir, "coverage.json"), "utf8")),
      ).toEqual({ intervals: expected });
    }));
});
