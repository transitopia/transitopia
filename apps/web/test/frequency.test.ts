import { describe, expect, it } from "vitest";
import { bandKey, bandOf, waitText } from "../src/TransitMap/frequency.ts";

describe("bandOf", () => {
  it("includes each band's upper limit", () => {
    expect(bandOf(3).id).toBe("good");
    expect(bandOf(6).id).toBe("good");
    // By whole minutes, as shown: "up to 6" is Good, "up to 7" OK.
    expect(bandOf(6.4).id).toBe("good");
    expect(bandOf(6.5).id).toBe("ok");
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

describe("waitText", () => {
  it("rounds to whole minutes, at least one", () => {
    expect(waitText(7.6)).toBe("Wait up to 8m");
    expect(waitText(0.2)).toBe("Wait up to 1m");
    expect(waitText(5, true)).toBe("wait up to 5m");
  });
});
