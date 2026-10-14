import { describe, expect, it } from "vitest";
import { overlayPadding } from "../src/TransitMap/overlayPadding.ts";

const rect = (left: number, top: number, width: number, height: number) => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
});

describe("overlayPadding", () => {
  const desktop = rect(0, 0, 1200, 800);

  it("counts each overlay against the edge it takes least of the map from", () => {
    const header = rect(0, 0, 1200, 56);
    const card = rect(800, 72, 384, 600);
    const timeBar = rect(300, 740, 600, 48);
    expect(overlayPadding(desktop, [header, card, timeBar])).toEqual({
      top: 56,
      right: 400,
      bottom: 60,
      left: 0,
    });
  });

  it("takes the deepest overlay on each edge and skips hidden ones", () => {
    expect(
      overlayPadding(desktop, [
        rect(0, 0, 1200, 56),
        rect(0, 0, 400, 120),
        rect(0, 0, 0, 0),
      ]),
    ).toEqual({ top: 120, right: 0, bottom: 0, left: 0 });
  });

  it("treats a phone's bottom sheet as a bottom band", () => {
    const phone = rect(0, 0, 390, 844);
    expect(overlayPadding(phone, [rect(0, 500, 390, 344)])).toEqual({
      top: 0,
      right: 0,
      bottom: 344,
      left: 0,
    });
  });

  it("ignores overlays outside the map", () => {
    const map = rect(0, 100, 1200, 700);
    expect(overlayPadding(map, [rect(0, 0, 1200, 56)])).toEqual({
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
    });
  });
});
