import { describe, expect, it } from "vitest";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServiceAlert } from "@transitopia/transit-core/disruption/alerts.ts";
import { AlertDrafts } from "../src/rt/alerts.ts";

const alert = (id: string, header: string): ServiceAlert => ({
  id,
  lines: ["expo"],
  stopIds: [],
  periods: [{ start: Date.parse("2026-10-03T05:00:00-07:00") }],
  header,
  description: "",
});

describe("AlertDrafts", () => {
  it("restores the last recorded alerts after a restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "alerts-"));
    try {
      const opts = { disruptionsDir: dir, historyDir: dir, log: () => {} };
      const first = new AlertDrafts(opts);
      expect(await first.restore()).toEqual([]);
      await first.update([alert("1", "Elevator at Braid is out of service.")]);
      const lim = alert("758307", "Expo Line LIM Rail Replacement.");
      await first.update([lim]);
      // A partly written line (the process stopped mid-write) is skipped.
      await appendFile(join(dir, "alerts.ndjson"), '{"ts":1,"alerts":[{"id"');

      const next = new AlertDrafts(opts);
      expect(await next.restore()).toEqual([lim]);
      expect(next.unparsed).toEqual([
        {
          id: "758307",
          lines: ["expo"],
          header: lim.header,
          reason: "no single-tracking or headway phrase",
        },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
