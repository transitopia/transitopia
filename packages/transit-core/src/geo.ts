// Geometry helpers. Coordinates are [lon, lat] (GeoJSON order); distances are metres.

export type LonLat = [number, number];

const R = 6_371_008.8;
const RAD = Math.PI / 180;

export function distM(a: LonLat, b: LonLat): number {
  const dLat = (b[1] - a[1]) * RAD;
  const dLon = (b[0] - a[0]) * RAD;
  const s =
    Math.sin(dLat / 2) ** 2
    + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Initial bearing a→b in degrees clockwise from north. */
export function bearingDeg(a: LonLat, b: LonLat): number {
  const φ1 = a[1] * RAD;
  const φ2 = b[1] * RAD;
  const Δλ = (b[0] - a[0]) * RAD;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

/** Cumulative distance at each vertex; cum[0] = 0, cum[n-1] = total length. */
export function cumulativeLengths(coords: LonLat[]): Float64Array {
  const cum = new Float64Array(coords.length);
  for (let i = 1; i < coords.length; i++)
    cum[i] = cum[i - 1]! + distM(coords[i - 1]!, coords[i]!);
  return cum;
}

/** Index i such that cum[i] <= d < cum[i+1] (clamped). */
function segmentIndex(cum: Float64Array, d: number): number {
  let lo = 0;
  let hi = cum.length - 1;
  if (d <= 0) return 0;
  if (d >= cum[hi]!) return Math.max(0, hi - 1);
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid]! <= d) lo = mid;
    else hi = mid;
  }
  return lo;
}

export interface PointAlong {
  lon: number;
  lat: number;
  bearing: number;
}

export function pointAlong(
  coords: LonLat[],
  cum: Float64Array,
  d: number,
): PointAlong {
  if (coords.length === 1)
    return { lon: coords[0]![0], lat: coords[0]![1], bearing: 0 };
  const i = segmentIndex(cum, d);
  const a = coords[i]!;
  const b = coords[i + 1]!;
  const len = cum[i + 1]! - cum[i]!;
  const f = len > 0 ? Math.min(1, Math.max(0, (d - cum[i]!) / len)) : 0;
  return {
    lon: a[0] + (b[0] - a[0]) * f,
    lat: a[1] + (b[1] - a[1]) * f,
    bearing: bearingDeg(a, b),
  };
}

/** The part of a polyline between two distances along it (m). */
export function sliceLine(
  coords: LonLat[],
  from: number,
  to: number,
  cum: Float64Array = cumulativeLengths(coords),
): LonLat[] {
  if (coords.length < 2) return coords;
  // Clamped, so neither end repeats a vertex.
  const len = cum[cum.length - 1]!;
  from = Math.min(len, Math.max(0, from));
  to = Math.min(len, Math.max(from, to));
  const at = (d: number): LonLat => {
    const p = pointAlong(coords, cum, d);
    return [p.lon, p.lat];
  };
  const out: LonLat[] = [at(from)];
  for (let i = 0; i < coords.length; i++)
    if (cum[i]! > from && cum[i]! < to) out.push(coords[i]!);
  out.push(at(to));
  return out;
}

/**
 * Local equirectangular projection around a reference latitude: accurate to well under 0.1% at
 * metro scale, and much cheaper than geodesic maths for projections and offsets.
 */
export function localProjector(refLat: number) {
  const kx = Math.cos(refLat * RAD) * RAD * R;
  const ky = RAD * R;
  return {
    toXY: (p: LonLat): [number, number] => [p[0] * kx, p[1] * ky],
    toLonLat: (x: number, y: number): LonLat => [x / kx, y / ky],
  };
}

export interface Projection {
  /** Distance along the polyline (m). */
  along: number;
  /** Perpendicular distance from the polyline (m). */
  offset: number;
}

/**
 * Project a point onto a polyline, searching forward from `fromAlong`. Returns the nearest point, but
 * stops at the first good match (< `acceptM`) once the line moves away, so loops or out-and-back shapes
 * don't snap a stop to a later pass of the same street.
 */
export function projectOnto(
  coords: LonLat[],
  cum: Float64Array,
  p: LonLat,
  fromAlong = 0,
  acceptM = 40,
): Projection {
  const proj = localProjector(p[1]);
  const [px, py] = proj.toXY(p);
  let best: Projection = { along: fromAlong, offset: Infinity };
  const start = segmentIndex(cum, fromAlong);
  for (let i = start; i < coords.length - 1; i++) {
    const [ax, ay] = proj.toXY(coords[i]!);
    const [bx, by] = proj.toXY(coords[i + 1]!);
    const dx = bx - ax;
    const dy = by - ay;
    const l2 = dx * dx + dy * dy;
    let f = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
    f = Math.min(1, Math.max(0, f));
    // Not before fromAlong: clamp within the segment containing it (skipping the segment would
    // match a point just behind fromAlong to some distant part of the line instead).
    const segLen = cum[i + 1]! - cum[i]!;
    if (cum[i]! + segLen * f < fromAlong)
      f = segLen > 0 ? Math.min(1, (fromAlong - cum[i]!) / segLen) : 1;
    const along = cum[i]! + segLen * f;
    const off = Math.hypot(ax + dx * f - px, ay + dy * f - py);
    if (off < best.offset) best = { along, offset: off };
    else if (best.offset < acceptM && off > best.offset + 500) break;
  }
  if (!Number.isFinite(best.offset))
    best = {
      along: Math.max(fromAlong, cum[cum.length - 1]!),
      offset: Infinity,
    };
  return best;
}

/** Douglas–Peucker simplification in metres. */
export function simplify(coords: LonLat[], toleranceM: number): LonLat[] {
  if (coords.length <= 2) return coords.slice();
  const proj = localProjector(coords[0]![1]);
  const xy = coords.map(proj.toXY);
  const keep = new Uint8Array(coords.length);
  keep[0] = 1;
  keep[coords.length - 1] = 1;
  const stack: [number, number][] = [[0, coords.length - 1]];
  const tol2 = toleranceM * toleranceM;
  while (stack.length) {
    const [s, e] = stack.pop()!;
    const [ax, ay] = xy[s]!;
    const [bx, by] = xy[e]!;
    const dx = bx - ax;
    const dy = by - ay;
    const l2 = dx * dx + dy * dy;
    let maxD = -1;
    let idx = -1;
    for (let i = s + 1; i < e; i++) {
      const [px, py] = xy[i]!;
      let f = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
      f = Math.min(1, Math.max(0, f));
      const d2 = (ax + dx * f - px) ** 2 + (ay + dy * f - py) ** 2;
      if (d2 > maxD) {
        maxD = d2;
        idx = i;
      }
    }
    if (maxD > tol2 && idx > 0) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return coords.filter((_, i) => keep[i]);
}

export interface StopSpurLimits {
  /** A vertex on a stop at most this far off the line between its neighbours is the curb (m). */
  curbM: number;
  /** Further off, up to this, only with a jog this short to or from a neighbour (m). */
  spurM: number;
  /** A vertex this close to a stop is on it (m). */
  onStopM?: number | undefined;
}

/**
 * Drops interior vertices placed on a stop. Some feeds (BC Transit) build sparse shapes with a
 * vertex at each curbside stop, which draws as a bump to the curb, or as a diagonal to the curb
 * and a short jog back to the road. A stop on a corner or a curve stays: it is far from the chord
 * across it, with no short jog.
 */
export function removeStopSpurs(
  coords: LonLat[],
  stops: LonLat[],
  { curbM, spurM, onStopM = 1 }: StopSpurLimits,
): LonLat[] {
  if (coords.length <= 2 || !stops.length) return coords.slice();
  const proj = localProjector(coords[0]![1]);
  const xy = coords.map(proj.toXY);
  const stopXY = stops.map(proj.toXY);
  const onStop = (x: number, y: number) =>
    stopXY.some(([sx, sy]) => Math.hypot(sx - x, sy - y) <= onStopM);
  const out: LonLat[] = [coords[0]!];
  let prev = xy[0]!;
  for (let i = 1; i < coords.length - 1; i++) {
    const [px, py] = xy[i]!;
    if (onStop(px, py)) {
      const [ax, ay] = prev;
      const [bx, by] = xy[i + 1]!;
      const dx = bx - ax;
      const dy = by - ay;
      const l2 = dx * dx + dy * dy;
      let f = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
      f = Math.min(1, Math.max(0, f));
      const offset = Math.hypot(ax + dx * f - px, ay + dy * f - py);
      const jog = Math.min(
        Math.hypot(px - ax, py - ay),
        Math.hypot(bx - px, by - py),
      );
      if (offset <= curbM || (offset <= spurM && jog <= spurM)) continue;
    }
    out.push(coords[i]!);
    prev = xy[i]!;
  }
  out.push(coords[coords.length - 1]!);
  return out;
}

export function round(n: number, decimals: number): number {
  const k = 10 ** decimals;
  return Math.round(n * k) / k;
}
