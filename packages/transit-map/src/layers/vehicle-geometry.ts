// The geometry behind vehicle shapes (vehicles.ts), in absolute mercator coordinates (0–1 across
// the world): outlines, ribbons along the track, and the tests used for picking. Pure, so it's
// tested without a map (packages/transit-map/test/vehicle-geometry.test.ts).

import type { VehicleState } from "@transitopia/transit-core/schedule/engine.ts";

export const EARTH_CIRCUMFERENCE = 40_075_016.686;

/** Ground metres per CSS pixel at a latitude and (MapLibre, 512 px tiles) zoom. */
export function metresPerPixel(lat: number, zoom: number): number {
  return (
    (EARTH_CIRCUMFERENCE * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** zoom)
  );
}

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function mercX(lon: number): number {
  return (lon + 180) / 360;
}
export function mercY(lat: number): number {
  const φ = (lat * Math.PI) / 180;
  return (1 - Math.log(Math.tan(φ) + 1 / Math.cos(φ)) / Math.PI) / 2;
}

/** Pointed-rectangle outline in absolute mercator coordinates (convex). */
export function vehicleOutline(
  v: VehicleState,
  lengthM: number,
  widthM: number,
): Float64Array {
  const perM = 1 / (EARTH_CIRCUMFERENCE * Math.cos((v.lat * Math.PI) / 180));
  const cx = mercX(v.lon);
  const cy = mercY(v.lat);
  const θ = (v.bearing * Math.PI) / 180;
  // Forward and right unit vectors in mercator (y grows southward).
  const fx = Math.sin(θ);
  const fy = -Math.cos(θ);
  const rx = Math.cos(θ);
  const ry = Math.sin(θ);
  const hl = lengthM / 2;
  const hw = widthM / 2;
  const nose = Math.min(hl * 0.5, widthM * 0.9);
  const local = [
    [-hl, -hw],
    [-hl, hw],
    [hl - nose, hw],
    [hl, 0],
    [hl - nose, -hw],
  ] as const;
  const out = new Float64Array(local.length * 2);
  local.forEach(([a, c], i) => {
    out[i * 2] = cx + (fx * a + rx * c) * perM;
    out[i * 2 + 1] = cy + (fy * a + ry * c) * perM;
  });
  return out;
}

/** Inset a convex polygon by distance d (miter join). */
export function inset(poly: Float64Array, d: number): Float64Array {
  const n = poly.length / 2;
  // Signed area decides which side is "inside".
  let area = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += poly[i * 2]! * poly[j * 2 + 1]! - poly[j * 2]! * poly[i * 2 + 1]!;
  }
  const sign = area > 0 ? 1 : -1;
  const normals = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ex = poly[j * 2]! - poly[i * 2]!;
    const ey = poly[j * 2 + 1]! - poly[i * 2 + 1]!;
    const len = Math.hypot(ex, ey) || 1;
    normals[i * 2] = (-ey / len) * sign;
    normals[i * 2 + 1] = (ex / len) * sign;
  }
  const out = new Float64Array(poly.length);
  for (let i = 0; i < n; i++) {
    const p = (i + n - 1) % n;
    const nx = normals[p * 2]! + normals[i * 2]!;
    const ny = normals[p * 2 + 1]! + normals[i * 2 + 1]!;
    const k =
      1
      + normals[p * 2]! * normals[i * 2]!
      + normals[p * 2 + 1]! * normals[i * 2 + 1]!;
    const s = k > 1e-6 ? d / k : d;
    out[i * 2] = poly[i * 2]! + nx * s;
    out[i * 2 + 1] = poly[i * 2 + 1]! + ny * s;
  }
  return out;
}

/**
 * A ribbon along a tail→head polyline (absolute mercator), half-width `hw`, tapering to a nose over
 * the last `nose` mercator units. Returns left and right edge vertices, tail first.
 */
export function ribbon(
  line: Float64Array,
  hw: number,
  nose: number,
): { left: Float64Array; right: Float64Array } {
  const n = line.length / 2;
  const left = new Float64Array(n * 2);
  const right = new Float64Array(n * 2);
  // Distance from each vertex to the head, for the taper.
  const toHead = new Float64Array(n);
  for (let i = n - 2; i >= 0; i--) {
    toHead[i] =
      toHead[i + 1]!
      + Math.hypot(
        line[(i + 1) * 2]! - line[i * 2]!,
        line[(i + 1) * 2 + 1]! - line[i * 2 + 1]!,
      );
  }
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1);
    const b = Math.min(n - 1, i + 1);
    let dx = line[b * 2]! - line[a * 2]!;
    let dy = line[b * 2 + 1]! - line[a * 2 + 1]!;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    const w =
      hw * Math.min(1, 0.2 + (0.8 * toHead[i]!) / Math.max(nose, 1e-12));
    left[i * 2] = line[i * 2]! - dy * w;
    left[i * 2 + 1] = line[i * 2 + 1]! + dx * w;
    right[i * 2] = line[i * 2]! + dy * w;
    right[i * 2 + 1] = line[i * 2 + 1]! - dx * w;
  }
  return { left, right };
}

/** A copy of a polyline with its first and last points moved outward by d along the end segments. */
export function extendEnds(line: Float64Array, d: number): Float64Array {
  const out = line.slice();
  const n = line.length / 2;
  if (n < 2) return out;
  const push = (end: number, from: number) => {
    const dx = line[end * 2]! - line[from * 2]!;
    const dy = line[end * 2 + 1]! - line[from * 2 + 1]!;
    const len = Math.hypot(dx, dy) || 1;
    out[end * 2] = line[end * 2]! + (dx / len) * d;
    out[end * 2 + 1] = line[end * 2 + 1]! + (dy / len) * d;
  };
  push(0, 1);
  push(n - 1, n - 2);
  return out;
}

export function distToPolyline(
  line: Float64Array,
  x: number,
  y: number,
): number {
  let best = Infinity;
  for (let i = 0; i + 3 < line.length; i += 2) {
    const ax = line[i]!;
    const ay = line[i + 1]!;
    const bx = line[i + 2]!;
    const by = line[i + 3]!;
    const dx = bx - ax;
    const dy = by - ay;
    const l2 = dx * dx + dy * dy;
    const f =
      l2 > 0 ?
        Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / l2))
      : 0;
    best = Math.min(best, Math.hypot(ax + dx * f - x, ay + dy * f - y));
  }
  return best;
}

export function pointInConvex(
  poly: Float64Array,
  x: number,
  y: number,
): boolean {
  const n = poly.length / 2;
  let sign = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const cross =
      (poly[j * 2]! - poly[i * 2]!) * (y - poly[i * 2 + 1]!)
      - (poly[j * 2 + 1]! - poly[i * 2 + 1]!) * (x - poly[i * 2]!);
    if (cross !== 0) {
      if (sign === 0) sign = Math.sign(cross);
      else if (Math.sign(cross) !== sign) return false;
    }
  }
  return true;
}

/** The factor on the minimum drawn sizes at a zoom: linear between stops, held past the ends. */
export function minScaleAt(stops: [number, number][], zoom: number): number {
  const i = stops.findIndex(([z]) => z > zoom);
  if (i === 0) return stops[0]![1];
  if (i === -1) return stops[stops.length - 1]![1];
  const [z0, f0] = stops[i - 1]!;
  const [z1, f1] = stops[i]!;
  return f0 + ((f1 - f0) * (zoom - z0)) / (z1 - z0);
}
