import { describe, expect, it } from "vitest";
import { PassDetector, type Band, type DetectedPass } from "../src/detector.ts";
import { createRgba, type Rgba } from "../src/image.ts";

const W = 320;
const H = 120;

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
  bands: Band[],
  shake?: (i: number) => number,
  dropped: (i: number) => boolean = () => false,
): DetectedPass[] {
  const d = new PassDetector({ bands });
  const passes: DetectedPass[] = [];
  for (let i = 0; i < frames; i++)
    if (!dropped(i))
      passes.push(...d.push({ t: i / 30, img: frame(i, trains, shake?.(i)) }));
  return [...passes, ...d.flush()];
}

/** A train covering rows [top, bottom) of the frame (fractions), moving dx pixels a frame. */
const train = (
  top: number,
  bottom: number,
  dx: number,
  length = 3 * W,
): Train => ({
  top: Math.round(top * H),
  bottom: Math.round(bottom * H),
  x0: dx > 0 ? -length : W,
  dx,
  length,
  pattern: texture(Math.round(top * 100) + 7, length, H),
});

const summary = (passes: DetectedPass[]) =>
  passes
    .map((p) => [p.track, p.direction])
    .sort((a, b) => Number(a[0]) - Number(b[0]));

describe("PassDetector", () => {
  // From level or below, a near train is taller and hides far trains' lower parts.
  const level: Band[] = [
    [0, 1],
    [0.5, 1],
  ];

  it("level view: a near-track train moving right", () => {
    const [p, ...rest] = run(110, [train(0, 1, 12)], level);
    expect(rest).toEqual([]);
    expect(p).toMatchObject({ track: 0, direction: 1, occluded: false });
    expect(p!.pxPerS).toBeCloseTo(360, -1);
    expect(p!.extent[0]).toBeLessThan(0.1);
    // The panorama is about as long as the train.
    expect(p!.panorama.width).toBeGreaterThan(3 * W - 40);
  });

  it("level view: a far-track train, shorter on screen, moving left", () => {
    const [p, ...rest] = run(110, [train(0.55, 1, -12)], level);
    expect(rest).toEqual([]);
    expect(p).toMatchObject({ track: 1, direction: -1 });
    // The panorama keeps the rows the train covered, with a margin, not the whole frame.
    expect(p!.panorama.height).toBeLessThan(H);
  });

  // From above, three tracks are three lanes; nearer trains (drawn last) are lower on screen.
  const above: Band[] = [
    [0.66, 1],
    [0.33, 0.63],
    [0, 0.3],
  ];

  it("from above: one train on each of three tracks", () => {
    for (const [i, [top, bottom]] of above.entries())
      expect(summary(run(110, [train(top, bottom, 12)], above))).toEqual([
        [i, 1],
      ]);
  });

  it("from above: trains passing each other on two tracks", () => {
    const passes = run(110, [train(0, 0.3, -12), train(0.66, 1, 12)], above);
    expect(summary(passes)).toEqual([
      [0, 1],
      [2, -1],
    ]);
  });

  it("without bands, passes have rows but no track", () => {
    const [p] = run(110, [train(0.33, 0.63, 12)], []);
    expect(p!.track).toBeUndefined();
    expect(p!.extent[0]).toBeCloseTo(0.33, 1);
    expect(p!.extent[1]).toBeCloseTo(0.63, 1);
  });

  it("keeps one pass when frames arrive irregularly (a browser skipping frames)", () => {
    const passes = run(
      110,
      [train(0, 1, 12)],
      level,
      undefined,
      (i) => i % 7 === 3 || i % 11 === 5,
    );
    expect(summary(passes)).toEqual([[0, 1]]);
    expect(passes[0]!.travelPx).toBeGreaterThan(3 * W);
  });

  it("ignores camera shake", () => {
    expect(run(60, [], level, (i) => (i % 3) - 1)).toEqual([]);
  });
});
