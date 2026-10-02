import { describe, expect, it } from "vitest";
import { carsFromTexts, pairs, partner, uncertainTexts } from "../src/cars.ts";
import type { OcrText } from "../src/ocr.ts";

const text = (
  digits: string,
  x: number,
  confidence = 0.99,
  h = 30,
): OcrText => ({
  box: { x, y: 80, w: 60, h },
  text: digits,
  digits,
  confidence,
});

describe("car numbers", () => {
  it("names married-pair partners (odd n with n + 1)", () => {
    expect(partner("097")).toBe("098");
    expect(partner("098")).toBe("097");
    expect(partner("335")).toBe("336");
    expect(partner("12")).toBeUndefined();
    expect(pairs(["336", "335", "310", "317"])).toEqual([
      "335·336",
      "309·310",
      "317·318",
    ]);
  });

  it("keeps confident three-digit readings, merges repeats and orders them front first", () => {
    const texts = [
      text("334", 2242),
      text("333", 2665, 0.95),
      text("318", 7428),
      text("318", 7300, 0.9),
      text("128", 1954, 0.69), // a misread Mk I number: not confident
      text("35", 2364, 0.99), // too short
      text("000", 5665, 0.99, 200), // a window, not a number
    ];
    // Moving right: the front is at the panorama's right end.
    const right = carsFromTexts(texts, 540, true);
    expect(right.map((c) => c.number)).toEqual(["318", "333", "334"]);
    expect(right[0]).toMatchObject({ reads: 2, confidence: 0.99 });
    expect(carsFromTexts(texts, 540, false).map((c) => c.number)).toEqual([
      "334",
      "333",
      "318",
    ]);
  });

  it("keeps uncertain number-like text for people to check", () => {
    const texts = [
      text("334", 1),
      text("128", 2, 0.69),
      text("35", 3, 0.7),
      text("7", 4, 0.9),
      text("000", 5, 0.4, 200),
    ];
    expect(uncertainTexts(texts, 540).map((t) => t.digits)).toEqual([
      "35",
      "128",
    ]);
  });
});
