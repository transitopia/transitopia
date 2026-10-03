// Detects trains passing a fixed camera beside the guideway (packages/trackside/README.md#detecting-passes).
//
// Each frame is the region of interest (ROI): the part of the view trains pass through. A
// horizontal split line divides it into two bands, placed so that above it only one track's trains
// can appear (`upper`). From below the guideway that's the near track: its trains look taller, and
// the near side wall hides far trains' lower halves. From above, looking down, it's the far track:
// it's higher on screen, and near trains cover far trains' lower parts. So the upper track is busy
// when the upper band moves, and the other track when the lower band moves in a way the upper
// track's train doesn't explain. In each band the horizontal shift between frames comes from block matching on moving
// pixels at reduced resolution. While a train passes, a strip as wide as its shift is cut from
// the centre column of each frame (a slit scan); together the strips make a panorama of the whole
// train, sharper than any frame and with every car side-on, which is what car numbers are read from.

import { createRgba, hstack, type Rgba } from "./image.ts";
import type { TrackSide } from "./types.ts";

export interface DetectorOptions {
  /** The split line, as a fraction of the ROI height from its top (0–1). */
  splitY: number;
  /** The track whose trains alone can appear above the split: near from below the guideway, far from above. */
  upper?: TrackSide;
  /** The slit, as a fraction of the ROI width from its left. */
  slitX?: number;
  /** Block matching runs at 1/downscale resolution. */
  downscale?: number;
  /** Largest shift between frames to look for, in ROI pixels. */
  maxShiftPx?: number;
  /** Smaller shifts are camera shake, not trains, in ROI pixels per frame. */
  minShiftPx?: number;
  /** Luma change that counts a pixel as moving (0–255). */
  motionThreshold?: number;
  /** Share of a band's pixels that must move. */
  minMovingFraction?: number;
  /** How many moving frames in a row start a pass, and how long without motion ends it. */
  startFrames?: number;
  endAfterS?: number;
  /** A pass must carry the train this far past the slit (a fraction of the ROI width), or it's noise. */
  minTravel?: number;
}

/** Lower-band motion within this fraction of the upper track's speed is that train (see push()). */
const TAIL_SPEED_TOLERANCE = 0.35;

const DEFAULTS: Required<Omit<DetectorOptions, "splitY">> = {
  upper: "near",
  slitX: 0.5,
  downscale: 4,
  maxShiftPx: 160,
  minShiftPx: 3,
  motionThreshold: 14,
  minMovingFraction: 0.12,
  startFrames: 3,
  endAfterS: 0.5,
  minTravel: 1.5,
};

/** One frame of the ROI, at `t` seconds (any clock, as long as it's monotonic). */
export interface Frame {
  t: number;
  img: Rgba;
}

export interface DetectedPass {
  track: TrackSide;
  /** +1: moving right on screen; −1: left. */
  direction: 1 | -1;
  startT: number;
  endT: number;
  /** Median image speed in ROI pixels per second. */
  pxPerS: number;
  /** How far the train moved past the slit, in ROI pixels (≈ its length in the panorama). */
  travelPx: number;
  /** The other track's train hid this one for part of the pass. */
  occluded: boolean;
  /** The train side-on, left to right as on screen (never mirrored, so numbers read normally). */
  panorama: Rgba;
}

/** What each band is doing now (for the live view). */
export interface BandState {
  moving: boolean;
  /** Shift in ROI pixels per frame (+ right). */
  dx: number;
  movingFraction: number;
}

interface Active {
  track: TrackSide;
  startT: number;
  lastMovingT: number;
  /** Signed shifts and their frame intervals. */
  shifts: number[];
  speeds: number[];
  strips: Rgba[];
  carry: number;
  travel: number;
  occluded: boolean;
  /** Consecutive moving frames so far (the pass is confirmed at `startFrames`). */
  run: number;
}

export class PassDetector {
  private readonly opts: Required<DetectorOptions>;
  private prev:
    { t: number; luma: Float32Array; w: number; h: number } | undefined;
  private readonly active = new Map<TrackSide, Active>();
  /** The latest band states, for display. */
  near: BandState = { moving: false, dx: 0, movingFraction: 0 };
  far: BandState = { moving: false, dx: 0, movingFraction: 0 };

  constructor(opts: DetectorOptions) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  setSplit(splitY: number, upper?: TrackSide): void {
    this.opts.splitY = splitY;
    if (upper) this.opts.upper = upper;
  }

  /** Feed the next frame; returns any passes that just ended. */
  push(frame: Frame): DetectedPass[] {
    const { img, t } = frame;
    const k = this.opts.downscale;
    const w = Math.floor(img.width / k);
    const h = Math.floor(img.height / k);
    const luma = smallLuma(img, k, w, h);
    const prev = this.prev;
    this.prev = { t, luma, w, h };
    if (!prev || prev.w !== w || prev.h !== h) return [];
    const dt = t - prev.t;
    if (!(dt > 0)) return [];

    const split = Math.max(
      1,
      Math.min(h - 1, Math.round(this.opts.splitY * h)),
    );
    const upper = this.band(prev.luma, luma, w, 0, split);
    const lower = this.band(prev.luma, luma, w, split, h);
    const top = this.opts.upper;
    const other: TrackSide = top === "near" ? "far" : "near";
    // Lower-band motion is the upper track's train when it moves with it: the rest of that train,
    // or its sloped ends, which leave the upper band first. Otherwise it's the other track.
    const a = this.active.get(top);
    const withUpper =
      lower.moving
      && ((upper.moving && sameMotion(lower.dx, upper.dx))
        || (a !== undefined
          && a.run >= this.opts.startFrames
          && Math.sign(lower.dx) === majority(a.shifts)
          && sameMotion(Math.abs(lower.dx), median(a.shifts.map(Math.abs)))));
    const topMoving = upper.moving || withUpper;
    const topDx = upper.moving ? upper.dx : lower.dx;
    const otherMoving = lower.moving && !withUpper;
    const states = {
      [top]: { ...upper, moving: topMoving, dx: topDx },
      [other]: { ...lower, moving: otherMoving },
    } as Record<TrackSide, BandState>;
    this.near = states.near;
    this.far = states.far;

    const ended: DetectedPass[] = [];
    this.step(top, topMoving, topDx, dt, t, img, ended);
    // While the upper track's train fills the lower band, the other track can't be seen.
    if (withUpper && this.active.has(other))
      this.active.get(other)!.occluded = true;
    if (otherMoving) this.step(other, true, lower.dx, dt, t, img, ended);
    else if (withUpper) this.idleCheck(other, t, ended);
    else this.step(other, false, 0, dt, t, img, ended);
    return ended;
  }

  /** End any pass in progress (e.g. when the camera stops). */
  flush(): DetectedPass[] {
    const out: DetectedPass[] = [];
    for (const track of this.active.keys()) {
      const p = this.finish(track);
      if (p) out.push(p);
    }
    return out;
  }

  private step(
    track: TrackSide,
    moving: boolean,
    dx: number,
    dt: number,
    t: number,
    img: Rgba,
    ended: DetectedPass[],
  ): void {
    const a = this.active.get(track);
    if (moving) {
      const cur = a ?? {
        track,
        startT: t - dt,
        lastMovingT: t,
        shifts: [],
        speeds: [],
        strips: [],
        carry: 0,
        travel: 0,
        occluded: false,
        run: 0,
      };
      if (!a) this.active.set(track, cur);
      // A shift against the pass's direction is a mismatch, not the train reversing.
      const dir = majority(cur.shifts);
      if (dir && Math.sign(dx) !== dir) return;
      cur.run++;
      cur.lastMovingT = t;
      cur.shifts.push(dx);
      cur.speeds.push(Math.abs(dx) / dt);
      cur.strips.push(this.strip(img, dx, cur));
      return;
    }
    if (a && a.run < this.opts.startFrames && t - a.lastMovingT > 0) {
      // Not enough moving frames in a row to be a train.
      this.active.delete(track);
      return;
    }
    this.idleCheck(track, t, ended);
  }

  private idleCheck(track: TrackSide, t: number, ended: DetectedPass[]): void {
    const a = this.active.get(track);
    if (a && t - a.lastMovingT >= this.opts.endAfterS) {
      const p = this.finish(track);
      if (p) ended.push(p);
    }
  }

  private finish(track: TrackSide): DetectedPass | undefined {
    const a = this.active.get(track);
    this.active.delete(track);
    if (!a || !this.prev) return undefined;
    const width = this.prev.w * this.opts.downscale;
    const direction = majority(a.shifts);
    if (!direction || a.travel < this.opts.minTravel * width) return undefined;
    // Moving right, each new strip shows a part further back (left) of the train: reverse them so
    // the panorama reads left to right as on screen.
    const strips = direction > 0 ? [...a.strips].reverse() : a.strips;
    return {
      track,
      direction,
      startT: a.startT,
      endT: a.lastMovingT,
      pxPerS: median(a.speeds),
      travelPx: Math.round(a.travel),
      occluded: a.occluded,
      panorama: hstack(strips),
    };
  }

  /** The columns of `img` that moved past the slit since the last frame. */
  private strip(img: Rgba, dx: number, a: Active): Rgba {
    a.carry += Math.abs(dx);
    const w = Math.floor(a.carry);
    a.carry -= w;
    a.travel += w;
    const slit = Math.round(this.opts.slitX * img.width);
    // Moving right, the train points that crossed the slit are now just right of it; moving left, just left.
    const x0 = Math.max(0, Math.min(img.width - w, dx > 0 ? slit : slit - w));
    const out = createRgba(w, img.height);
    for (let y = 0; y < img.height; y++)
      out.data.set(
        img.data.subarray(
          (y * img.width + x0) * 4,
          (y * img.width + x0 + w) * 4,
        ),
        y * w * 4,
      );
    return out;
  }

  /** Motion in rows [y0, y1) of the small frames: share of moving pixels and the best shift. */
  private band(
    a: Float32Array,
    b: Float32Array,
    w: number,
    y0: number,
    y1: number,
  ): BandState {
    const { motionThreshold, minMovingFraction, minShiftPx, downscale } =
      this.opts;
    const moving: number[] = [];
    for (let y = y0; y < y1; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (Math.abs(b[i]! - a[i]!) > motionThreshold) moving.push(i);
      }
    const fraction = moving.length / Math.max(1, (y1 - y0) * w);
    if (fraction < minMovingFraction)
      return { moving: false, dx: 0, movingFraction: fraction };
    // Block matching: the shift s (small pixels) minimising mean |b(x) − a(x − s)| over moving pixels.
    const maxS = Math.ceil(this.opts.maxShiftPx / downscale);
    const cost = new Float64Array(2 * maxS + 1);
    for (let s = -maxS; s <= maxS; s++) {
      let sum = 0;
      let n = 0;
      for (const i of moving) {
        const x = i % w;
        if (x - s < 0 || x - s >= w) continue;
        sum += Math.abs(b[i]! - a[i - s]!);
        n++;
      }
      cost[s + maxS] = n ? sum / n : Infinity;
    }
    let best = 0;
    for (let j = 1; j < cost.length; j++) if (cost[j]! < cost[best]!) best = j;
    // Sub-pixel: the vertex of the parabola through the best cost and its neighbours.
    let sub = 0;
    if (best > 0 && best < cost.length - 1) {
      const l = cost[best - 1]!;
      const c = cost[best]!;
      const r = cost[best + 1]!;
      const d = l - 2 * c + r;
      if (d > 0 && Number.isFinite(d)) sub = (0.5 * (l - r)) / d;
    }
    const dx = (best - maxS + sub) * downscale;
    return {
      moving: Math.abs(dx) >= minShiftPx,
      dx,
      movingFraction: fraction,
    };
  }
}

/** Luma averaged over k×k blocks. */
function smallLuma(img: Rgba, k: number, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  const d = img.data;
  const W = img.width;
  const norm = 1 / (k * k);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let dy = 0; dy < k; dy++) {
        let o = ((y * k + dy) * W + x * k) * 4;
        for (let dx = 0; dx < k; dx++, o += 4)
          s += 0.299 * d[o]! + 0.587 * d[o + 1]! + 0.114 * d[o + 2]!;
      }
      out[y * w + x] = s * norm;
    }
  return out;
}

/** Two shifts the same train could make (same direction, speed within TAIL_SPEED_TOLERANCE). */
function sameMotion(a: number, b: number): boolean {
  return (
    Math.sign(a) === Math.sign(b)
    && Math.abs(a - b) <= TAIL_SPEED_TOLERANCE * Math.abs(b)
  );
}

function majority(shifts: number[]): 1 | -1 | 0 {
  let s = 0;
  for (const x of shifts) s += Math.sign(x);
  return (
    s > 0 ? 1
    : s < 0 ? -1
    : 0
  );
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}
