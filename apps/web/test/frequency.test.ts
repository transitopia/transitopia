import { describe, expect, it } from "vitest";
import { bandKey, bandOf, everyText } from "../src/TransitMap/frequency.ts";

describe("bandOf", () => {
  it("includes each band's upper limit", () => {
    expect(bandOf(3).id).toBe("good");
    expect(bandOf(6).id).toBe("good");
    expect(bandOf(6.1).id).toBe("ok");
    expect(bandOf(12).id).toBe("ok");
    expect(bandOf(20).id).toBe("poor");
    expect(bandOf(21).id).toBe("bad");
    expect(bandOf(Infinity).id).toBe("bad");
  });

  it("colours bands with a theme property", () => {
    expect(bandOf(5).color).toBe("var(--band-good)");
  });
});

describe("bandKey", () => {
  it("lists every band with its range", () => {
    expect(bandKey().map((b) => `${b.name} ${b.range}`)).toEqual([
      "Good ≤6m",
      "OK ≤12m",
      "Poor ≤20m",
      "Bad >20m",
    ]);
  });
});

describe("everyText", () => {
  it("rounds to whole minutes, at least one", () => {
    expect(everyText(7.6)).toBe("every 8m");
    expect(everyText(0.2)).toBe("every 1m");
    expect(everyText(5, true)).toBe("every ~5m");
  });
});
