import { describe, expect, it } from "vitest";
import type { Disruption } from "@transitopia/transit-core/disruption/types.ts";
import { disruptionProblems } from "../src/app.ts";

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
