import { describe, expect, it } from "vitest";
import { components, decode } from "../src/ocr.ts";

describe("CTC decoding", () => {
  it("collapses repeats, drops blanks, and can allow only digits", () => {
    const keys = ["3", "1", "O", "7"];
    const digits = new Map([
      [1, "3"],
      [2, "1"],
      [4, "7"],
    ]);
    // Time steps over [blank, "3", "1", "O", "7"]: 3 3 _ 1 O(≈0) 7
    const rows = [
      [0, 1, 0, 0, 0],
      [0, 1, 0, 0, 0],
      [1, 0, 0, 0, 0],
      [0, 0, 1, 0, 0],
      [0.1, 0, 0.3, 0.6, 0],
      [0, 0, 0, 0, 1],
    ];
    const r = decode(
      Float32Array.from(rows.flat()),
      rows.length,
      5,
      keys,
      digits,
    );
    expect(r.text).toBe("31O7");
    // With only digits allowed, the "O" step reads as "1" (repeating the previous 1, so collapsed).
    expect(r.digits).toBe("317");
  });
});

describe("text boxes", () => {
  it("finds connected regions above the thresholds and grows them", () => {
    const w = 20;
    const h = 10;
    const p = new Float32Array(w * h);
    for (let y = 3; y < 6; y++) for (let x = 4; x < 12; x++) p[y * w + x] = 0.9;
    p[9 * w + 19] = 0.9; // a speck
    const boxes = components(p, w, h, {
      tileWidth: 0,
      tileOverlap: 0,
      pixelThreshold: 0.3,
      boxThreshold: 0.6,
      unclipRatio: 1.6,
      detScale: 1,
    });
    expect(boxes).toHaveLength(1);
    expect(boxes[0]!.x).toBeLessThan(4);
    expect(boxes[0]!.x + boxes[0]!.w).toBeGreaterThan(12);
  });
});
