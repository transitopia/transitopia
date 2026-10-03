import { describe, expect, it } from "vitest";
import { PassDetector, type DetectedPass } from "../src/detector.ts";
import { createRgba, type Rgba } from "../src/image.ts";

const W = 320;
const H = 120;
const SPLIT = 0.4;

/** A deterministic texture of 8×8 blocks. */
function texture(seed: number, width: number, height: number): Uint8Array {
  let s = seed;
  const rand = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const bw = Math.ceil(width / 8);
  const blocks = Array.from({ length: bw * Math.ceil(height / 8) }, () =>
    Math.floor(rand() * 256),
  );
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      out[y * width + x] = blocks[Math.floor(y / 8) * bw + Math.floor(x / 8)]!;
  return out;
}

const background = texture(1, W, H);

interface Train {
  /** Rows it covers: top to bottom (default: the frame's bottom). */
  top: number;
  bottom?: number;
  /** Position of its left end at frame 0, and pixels per frame (+ right). */
  x0: number;
  dx: number;
  length: number;
  pattern: Uint8Array;
}

function frame(i: number, trains: Train[], shake = 0): Rgba {
  const img = createRgba(W, H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const bx = Math.min(W - 1, Math.max(0, x + shake));
      let v = background[y * W + bx]!;
      for (const t of trains) {
        const tx = x - Math.round(t.x0 + t.dx * i);
        if (y >= t.top && y < (t.bottom ?? H) && tx >= 0 && tx < t.length)
          v = t.pattern[y * t.length + tx]!;
      }
      const o = (y * W + x) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = v;
      img.data[o + 3] = 255;
    }
  return img;
}

function run(
  frames: number,
  trains: Train[],
  shake?: (i: number) => number,
  upper: "near" | "far" = "near",
): DetectedPass[] {
  const d = new PassDetector({ splitY: SPLIT, upper });
  const passes: DetectedPass[] = [];
  for (let i = 0; i < frames; i++)
    passes.push(...d.push({ t: i / 30, img: frame(i, trains, shake?.(i)) }));
  return [...passes, ...d.flush()];
}

const train = (
  top: number,
  dx: number,
  length = 3 * W,
  bottom?: number,
): Train => ({
  top,
  ...(bottom !== undefined ? { bottom } : {}),
  x0: dx > 0 ? -length : W,
  dx,
  length,
  pattern: texture(top + 7, length, H),
});

describe("PassDetector", () => {
  it("finds a near-track train moving right", () => {
    const [p, ...rest] = run(110, [train(0, 12)]);
    expect(rest).toEqual([]);
    expect(p).toMatchObject({ track: "near", direction: 1, occluded: false });
    expect(p!.pxPerS).toBeCloseTo(360, -1);
    // The panorama is about as long as the train.
    expect(p!.panorama.width).toBeGreaterThan(3 * W - 40);
    expect(p!.panorama.height).toBe(H);
  });

  it("finds a far-track train (only below the split) moving left", () => {
    const [p, ...rest] = run(110, [train(Math.round(0.55 * H), -12)]);
    expect(rest).toEqual([]);
    expect(p).toMatchObject({ track: "far", direction: -1 });
  });

  // From above, the far track is higher on screen: its trains alone appear above the split, and
  // near trains (drawn last, in front) cover far trains' lower parts.
  const farFromAbove = (dx: number) => train(0, dx, 3 * W, Math.round(0.6 * H));
  const nearFromAbove = (dx: number) => train(Math.round(0.45 * H), dx);

  it("from above: a far-track train above the split", () => {
    const [p, ...rest] = run(110, [farFromAbove(-12)], undefined, "far");
    expect(rest).toEqual([]);
    expect(p).toMatchObject({ track: "far", direction: -1 });
  });

  it("from above: a near-track train below the split", () => {
    const [p, ...rest] = run(110, [nearFromAbove(12)], undefined, "far");
    expect(rest).toEqual([]);
    expect(p).toMatchObject({ track: "near", direction: 1 });
  });

  it("from above: trains passing each other on both tracks", () => {
    const passes = run(
      110,
      [farFromAbove(-12), nearFromAbove(12)],
      undefined,
      "far",
    );
    expect(
      passes
        .map((p) => [p.track, p.direction])
        .sort((a, b) => String(a).localeCompare(String(b))),
    ).toEqual([
      ["far", -1],
      ["near", 1],
    ]);
  });

  it("ignores camera shake", () => {
    expect(run(60, [], (i) => (i % 3) - 1)).toEqual([]);
  });
});
