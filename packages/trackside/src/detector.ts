// Detects trains passing a fixed camera beside the guideway (packages/trackside/README.md#detecting-passes).
//
// Each frame is the region of interest (ROI): the part of the view trains pass through. It's
// divided into horizontal strips; in each, the horizontal shift between frames comes from block
// matching on moving pixels at reduced resolution. Neighbouring moving strips with the same motion
// are one moving object (a train, or the part of it in view), so two trains moving differently,
// e.g. passing each other, are two objects. Objects are followed from frame to frame as passes.
//
// Which track a pass is on comes from the rows it covered: each track in view has a band where its
// trains appear (set by the user over the preview), and the pass goes to the band it matches best.
// From above, tracks are separate lanes on screen; from level or below, a near train covers more
// rows than a far one (it's bigger, and its roof is higher). The rows are reported too, so the
// server can reassign tracks later.
//
// While a train passes, a strip as wide as its shift is cut from the centre column of each frame (a
// slit scan); together the strips make a panorama of the whole train, sharper than any frame and
// with every car side-on, which is what car numbers are read from.

import { createRgba, crop, hstack, type Rgba } from "./image.ts";

/** A band of rows, as fractions of the ROI height from its top: [top, bottom]. */
export type Band = [number, number];

export interface DetectorOptions {
  /** Where each track's trains appear, nearest track first. Without bands, passes have no track. */
  bands?: Band[];
  /** The slit, as a fraction of the ROI width from its left. */
  slitX?: number;
  /** Block matching runs at 1/downscale resolution. */
  downscale?: number;
  /** How many horizontal strips the ROI is divided into. */
  strips?: number;
  /** Largest shift between frames to look for, in ROI pixels. */
  maxShiftPx?: number;
  /** Smaller shifts are camera shake, not trains, in ROI pixels per frame. */
  minShiftPx?: number;
  /** Luma change that counts a pixel as moving (0–255). */
  motionThreshold?: number;
  /** Share of a strip's pixels that must move. */
  minMovingFraction?: number;
  /** How many moving frames start a pass, and how long without motion ends it. */
  startFrames?: number;
  endAfterS?: number;
  /** A pass must carry the train this far past the slit (a fraction of the ROI width), or it's noise. */
  minTravel?: number;
}

const DEFAULTS: Required<Omit<DetectorOptions, "bands">> = {
  slitX: 0.5,
  downscale: 4,
  strips: 24,
  maxShiftPx: 160,
  minShiftPx: 3,
  motionThreshold: 14,
  minMovingFraction: 0.1,
  startFrames: 3,
  endAfterS: 0.5,
  minTravel: 1,
};

/** Shifts the same train could make: same direction, speed within this fraction. */
const SAME_MOTION = 0.35;
/** Moving strips this far apart (in strips) with the same motion are still one object. */
const MAX_GAP = 2;
/**
 * Panoramas keep this margin around the rows seen moving, as a fraction of their height (at least
 * MIN_PANORAMA_MARGIN of the ROI): plain roofs and skirts barely register as moving, and car
 * numbers sit near the roof.
 */
const PANORAMA_MARGIN = 0.5;
const MIN_PANORAMA_MARGIN = 0.05;

/** One frame of the ROI, at `t` seconds (any clock, as long as it's monotonic). */
export interface Frame {
  t: number;
  img: Rgba;
}

/** Something moving in this frame: the rows it covers (fractions of the ROI height) and its shift. */
export interface MovingObject {
  top: number;
  bottom: number;
  /** Shift in ROI pixels per frame (+ right). */
  dx: number;
  /** The track whose band it matches best, if there are bands. */
  track?: number | undefined;
}

export interface DetectedPass {
  /** Index into the bands (0: nearest track), if there are bands. */
  track?: number | undefined;
  /** +1: moving right on screen; −1: left. */
  direction: 1 | -1;
  startT: number;
  endT: number;
  /** Median image speed in ROI pixels per second. */
  pxPerS: number;
  /** How far the train moved past the slit, in ROI pixels (≈ its length in the panorama). */
  travelPx: number;
  /** The rows it covered (median over the pass), as fractions of the ROI height. */
  extent: Band;
  /** A bigger (nearer) train overlapped it on screen for part of the pass. */
  occluded: boolean;
  /** The train side-on, left to right as on screen (never mirrored, so numbers read normally). */
  panorama: Rgba;
}

interface Active {
  id: number;
  startT: number;
  lastMovingT: number;
  shifts: number[];
  /** Signed speeds in ROI pixels per second (frames can arrive irregularly, so shifts vary). */
  velocities: number[];
  tops: number[];
  bottoms: number[];
  strips: Rgba[];
  carry: number;
  travel: number;
  occluded: boolean;
}

export class PassDetector {
  private readonly opts: Required<Omit<DetectorOptions, "bands">>;
  private bands: Band[];
  private prev:
    { t: number; luma: Float32Array; w: number; h: number } | undefined;
  private active: Active[] = [];
  private nextId = 1;
  /** What's moving in the latest frame (for the live view). */
  objects: MovingObject[] = [];

  constructor(opts: DetectorOptions = {}) {
    const { bands, ...rest } = opts;
    this.opts = { ...DEFAULTS, ...rest };
    this.bands = bands ?? [];
  }

  setBands(bands: Band[]): void {
    this.bands = bands;
  }

  /** The band an extent matches best (by overlap over union), if any. */
  trackOf(top: number, bottom: number): number | undefined {
    let best: number | undefined;
    let bestScore = 0;
    this.bands.forEach(([t, b], i) => {
      const inter = Math.min(b, bottom) - Math.max(t, top);
      const union = Math.max(b, bottom) - Math.min(t, top);
      const score = inter > 0 && union > 0 ? inter / union : 0;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    });
    return best;
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

    const objects = this.findObjects(prev.luma, luma, w, h);
    this.objects = objects.map((o) => ({
      ...o,
      track: this.trackOf(o.top, o.bottom),
    }));

    // Match objects to passes in progress: same motion, overlapping rows (best overlap first).
    const claimed = new Map<Active, MovingObject>();
    const unmatched: MovingObject[] = [];
    for (const o of objects) {
      let best: Active | undefined;
      let bestOverlap = 0;
      for (const a of this.active) {
        if (!sameMotion(o.dx / dt, recentVelocity(a))) continue;
        const top = median(a.tops.slice(-15));
        const bottom = median(a.bottoms.slice(-15));
        const overlap = Math.min(bottom, o.bottom) - Math.max(top, o.top);
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          best = a;
        }
      }
      if (!best) unmatched.push(o);
      else {
        // Two objects matching one pass are parts of one train (a gap in its texture): join them.
        const seen = claimed.get(best);
        claimed.set(
          best,
          seen ?
            {
              top: Math.min(seen.top, o.top),
              bottom: Math.max(seen.bottom, o.bottom),
              dx: (seen.dx + o.dx) / 2,
            }
          : o,
        );
      }
    }
    for (const o of unmatched) {
      const a: Active = {
        id: this.nextId++,
        startT: t - dt,
        lastMovingT: t,
        shifts: [],
        velocities: [],
        tops: [],
        bottoms: [],
        strips: [],
        carry: 0,
        travel: 0,
        occluded: false,
      };
      this.active.push(a);
      claimed.set(a, o);
    }
    for (const [a, o] of claimed) {
      a.lastMovingT = t;
      a.shifts.push(o.dx);
      a.velocities.push(o.dx / dt);
      a.tops.push(o.top);
      a.bottoms.push(o.bottom);
      a.strips.push(this.strip(img, o.dx, a));
    }
    // A taller object overlapping another is in front of it.
    const now = [...claimed];
    for (const [a, o] of now)
      for (const [b, p] of now)
        if (
          a !== b
          && p.bottom - p.top > o.bottom - o.top
          && Math.min(o.bottom, p.bottom) > Math.max(o.top, p.top)
        )
          a.occluded = true;

    const ended: DetectedPass[] = [];
    for (const a of this.active) {
      if (claimed.has(a)) continue;
      // Not seen for a moment: a few frames of noise are dropped, a train that's gone has passed.
      if (a.shifts.length < this.opts.startFrames) this.drop(a);
      else if (t - a.lastMovingT >= this.opts.endAfterS) {
        const p = this.finish(a);
        if (p) ended.push(p);
      }
    }
    return ended;
  }

  /** End any pass in progress (e.g. when the camera stops). */
  flush(): DetectedPass[] {
    const out: DetectedPass[] = [];
    for (const a of this.active) {
      const p = this.finish(a);
      if (p) out.push(p);
    }
    return out;
  }

  private drop(a: Active): void {
    this.active = this.active.filter((x) => x !== a);
  }

  private finish(a: Active): DetectedPass | undefined {
    this.drop(a);
    if (!this.prev) return undefined;
    const width = this.prev.w * this.opts.downscale;
    const direction = majority(a.shifts);
    if (
      !direction
      || a.shifts.length < this.opts.startFrames
      || a.travel < this.opts.minTravel * width
    )
      return undefined;
    const extent: Band = [median(a.tops), median(a.bottoms)];
    // Moving right, each new strip shows a part further back (left) of the train: reverse them so
    // the panorama reads left to right as on screen.
    const strips = direction > 0 ? [...a.strips].reverse() : a.strips;
    const full = hstack(strips);
    const margin = Math.max(
      MIN_PANORAMA_MARGIN,
      PANORAMA_MARGIN * (extent[1] - extent[0]),
    );
    const y0 = Math.max(0, Math.floor((extent[0] - margin) * full.height));
    const y1 = Math.min(
      full.height,
      Math.ceil((extent[1] + margin) * full.height),
    );
    return {
      track: this.trackOf(extent[0], extent[1]),
      direction,
      startT: a.startT,
      endT: a.lastMovingT,
      pxPerS: median(a.velocities.map(Math.abs)),
      travelPx: Math.round(a.travel),
      extent,
      occluded: a.occluded,
      panorama: crop(full, { x: 0, y: y0, w: full.width, h: y1 - y0 }),
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

  /** Moving objects: runs of moving strips with the same motion. */
  private findObjects(
    a: Float32Array,
    b: Float32Array,
    w: number,
    h: number,
  ): MovingObject[] {
    const n = Math.min(this.opts.strips, h);
    const rows = (i: number) => Math.round((i * h) / n);
    const strips = Array.from({ length: n }, (_, i) =>
      this.stripMotion(a, b, w, rows(i), rows(i + 1)),
    );
    const objects: MovingObject[] = [];
    let cur: { first: number; last: number; shifts: number[] } | undefined;
    const close = () => {
      if (cur && cur.last > cur.first) {
        objects.push({
          top: rows(cur.first) / h,
          bottom: rows(cur.last + 1) / h,
          dx: median(cur.shifts),
        });
      }
      cur = undefined;
    };
    strips.forEach((dx, i) => {
      if (dx === undefined) {
        if (cur && i - cur.last > MAX_GAP) close();
        return;
      }
      if (cur && !sameMotion(dx, median(cur.shifts))) close();
      if (!cur) cur = { first: i, last: i, shifts: [dx] };
      else {
        cur.last = i;
        cur.shifts.push(dx);
      }
    });
    close();
    return objects;
  }

  /** The shift of rows [y0, y1) of the small frames, or undefined if they aren't moving. */
  private stripMotion(
    a: Float32Array,
    b: Float32Array,
    w: number,
    y0: number,
    y1: number,
  ): number | undefined {
    const { motionThreshold, minMovingFraction, minShiftPx, downscale } =
      this.opts;
    const moving: number[] = [];
    for (let y = y0; y < y1; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (Math.abs(b[i]! - a[i]!) > motionThreshold) moving.push(i);
      }
    if (moving.length < minMovingFraction * Math.max(1, (y1 - y0) * w))
      return undefined;
    // Block matching: the shift s (small pixels) minimising mean |b(x) − a(x − s)| over moving pixels.
    const maxS = Math.ceil(this.opts.maxShiftPx / downscale);
    const cost = new Float64Array(2 * maxS + 1);
    for (let s = -maxS; s <= maxS; s++) {
      let sum = 0;
      let count = 0;
      for (const i of moving) {
        const x = i % w;
        if (x - s < 0 || x - s >= w) continue;
        sum += Math.abs(b[i]! - a[i - s]!);
        count++;
      }
      cost[s + maxS] = count ? sum / count : Infinity;
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
    return Math.abs(dx) >= minShiftPx ? dx : undefined;
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

const recentVelocity = (a: Active): number => median(a.velocities.slice(-10));

/** Shifts the same train could make (same direction, speed within SAME_MOTION). */
function sameMotion(a: number, b: number): boolean {
  return (
    Math.sign(a) === Math.sign(b)
    && Math.abs(a - b) <= SAME_MOTION * Math.max(Math.abs(a), Math.abs(b))
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
