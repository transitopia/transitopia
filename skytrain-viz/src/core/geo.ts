// Geometry helpers. Coordinates are [lon, lat] (GeoJSON order); distances are metres.

export type LonLat = [number, number];

const R = 6_371_008.8;
const RAD = Math.PI / 180;

export function distM(a: LonLat, b: LonLat): number {
  const dLat = (b[1] - a[1]) * RAD;
  const dLon = (b[0] - a[0]) * RAD;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Initial bearing a→b in degrees clockwise from north. */
export function bearingDeg(a: LonLat, b: LonLat): number {
  const φ1 = a[1] * RAD;
  const φ2 = b[1] * RAD;
  const Δλ = (b[0] - a[0]) * RAD;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

/** Cumulative distance at each vertex; cum[0] = 0, cum[n-1] = total length. */
export function cumulativeLengths(coords: LonLat[]): Float64Array {
  const cum = new Float64Array(coords.length);
  for (let i = 1; i < coords.length; i++) cum[i] = cum[i - 1]! + distM(coords[i - 1]!, coords[i]!);
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

export function pointAlong(coords: LonLat[], cum: Float64Array, d: number): PointAlong {
  if (coords.length === 1) return { lon: coords[0]![0], lat: coords[0]![1], bearing: 0 };
  const i = segmentIndex(cum, d);
  const a = coords[i]!;
  const b = coords[i + 1]!;
  const len = cum[i + 1]! - cum[i]!;
  const f = len > 0 ? Math.min(1, Math.max(0, (d - cum[i]!) / len)) : 0;
  return { lon: a[0] + (b[0] - a[0]) * f, lat: a[1] + (b[1] - a[1]) * f, bearing: bearingDeg(a, b) };
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
    const along = cum[i]! + (cum[i + 1]! - cum[i]!) * f;
    if (along < fromAlong) continue;
    const off = Math.hypot(ax + dx * f - px, ay + dy * f - py);
    if (off < best.offset) best = { along, offset: off };
    else if (best.offset < acceptM && off > best.offset + 500) break;
  }
  if (!Number.isFinite(best.offset)) best = { along: Math.max(fromAlong, cum[cum.length - 1]!), offset: Infinity };
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

export function round(n: number, decimals: number): number {
  const k = 10 ** decimals;
  return Math.round(n * k) / k;
}
