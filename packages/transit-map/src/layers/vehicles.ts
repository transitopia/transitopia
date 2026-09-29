// Animated vehicles. Each is a pointed rectangle at true scale, enlarged to a minimum pixel size
// when zoomed out (PLAN.md §4.9), drawn by GlPolygonLayer. Estimated positions have a pale tint of
// the route colour with a route-coloured outline; observed ones are solid with a halo outline (§4.6),
// so both stand out against their own route line. Picking is done on the CPU.

import type { Map as MlMap } from 'maplibre-gl';
import type { VehicleState } from '@transitopia/transit-core/schedule/engine.ts';
import type { KinematicsConfig } from '@transitopia/transit-core/movement/kinematics.ts';
import { GlPolygonLayer, VERTEX_BYTES } from './gl-polygons.ts';
import { VEHICLES_BEFORE_LAYER } from './static.ts';

type RGBA = [number, number, number, number];

const LAYER_ID = 'vehicles';
const EARTH_CIRCUMFERENCE = 40_075_016.686;
const SELECTED: RGBA = [255, 64, 129, 255];
/** Estimated vehicles are filled with the route colour mixed this far toward the halo colour. */
const ESTIMATED_TINT = 0.55;
const PICK_TOLERANCE_PX = 5;

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mercX(lon: number): number {
  return (lon + 180) / 360;
}
function mercY(lat: number): number {
  const φ = (lat * Math.PI) / 180;
  return (1 - Math.log(Math.tan(φ) + 1 / Math.cos(φ)) / Math.PI) / 2;
}

/** Pointed-rectangle outline in absolute mercator coordinates (convex). */
function vehicleOutline(v: VehicleState, lengthM: number, widthM: number): Float64Array {
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
function inset(poly: Float64Array, d: number): Float64Array {
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
    const k = 1 + normals[p * 2]! * normals[i * 2]! + normals[p * 2 + 1]! * normals[i * 2 + 1]!;
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
function ribbon(line: Float64Array, hw: number, nose: number): { left: Float64Array; right: Float64Array } {
  const n = line.length / 2;
  const left = new Float64Array(n * 2);
  const right = new Float64Array(n * 2);
  // Distance from each vertex to the head, for the taper.
  const toHead = new Float64Array(n);
  for (let i = n - 2; i >= 0; i--) {
    toHead[i] = toHead[i + 1]! + Math.hypot(line[(i + 1) * 2]! - line[i * 2]!, line[(i + 1) * 2 + 1]! - line[i * 2 + 1]!);
  }
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1);
    const b = Math.min(n - 1, i + 1);
    let dx = line[b * 2]! - line[a * 2]!;
    let dy = line[b * 2 + 1]! - line[a * 2 + 1]!;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    const w = hw * Math.min(1, 0.2 + (0.8 * toHead[i]!) / Math.max(nose, 1e-12));
    left[i * 2] = line[i * 2]! - dy * w;
    left[i * 2 + 1] = line[i * 2 + 1]! + dx * w;
    right[i * 2] = line[i * 2]! + dy * w;
    right[i * 2 + 1] = line[i * 2 + 1]! - dx * w;
  }
  return { left, right };
}

function distToPolyline(line: Float64Array, x: number, y: number): number {
  let best = Infinity;
  for (let i = 0; i + 3 < line.length; i += 2) {
    const ax = line[i]!;
    const ay = line[i + 1]!;
    const bx = line[i + 2]!;
    const by = line[i + 3]!;
    const dx = bx - ax;
    const dy = by - ay;
    const l2 = dx * dx + dy * dy;
    const f = l2 > 0 ? Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(ax + dx * f - x, ay + dy * f - y));
  }
  return best;
}

function pointInConvex(poly: Float64Array, x: number, y: number): boolean {
  const n = poly.length / 2;
  let sign = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const cross =
      (poly[j * 2]! - poly[i * 2]!) * (y - poly[i * 2 + 1]!) - (poly[j * 2 + 1]! - poly[i * 2 + 1]!) * (x - poly[i * 2]!);
    if (cross !== 0) {
      if (sign === 0) sign = Math.sign(cross);
      else if (Math.sign(cross) !== sign) return false;
    }
  }
  return true;
}

export class VehicleLayer {
  private layer = new GlPolygonLayer(LAYER_ID);
  private colors = new Map<string, [number, number, number]>();
  private hits: ({ v: VehicleState; poly: Float64Array } | { v: VehicleState; line: Float64Array; hw: number })[] = [];
  private mercPerPx = 0;
  selectedId: string | undefined;

  constructor(
    private map: MlMap,
    private sizing: KinematicsConfig['sizing'],
  ) {}

  /** Add (or re-add after a style change) beneath the station labels. */
  attach(): void {
    const before = this.map.getLayer(VEHICLES_BEFORE_LAYER) ? VEHICLES_BEFORE_LAYER : undefined;
    // setStyle keeps custom layers, but the route/track layers are re-added above them: move it back.
    if (this.map.getLayer(LAYER_ID)) this.map.moveLayer(LAYER_ID, before);
    else this.map.addLayer(this.layer, before);
  }

  setRouteColors(routes: { key: string; color: string }[]): void {
    for (const r of routes) this.colors.set(r.key, hexToRgb(r.color));
  }

  update(vehicles: VehicleState[], dark: boolean): void {
    const zoom = this.map.getZoom();
    const center = this.map.getCenter();
    const mPerPx = (EARTH_CIRCUMFERENCE * Math.cos((center.lat * Math.PI) / 180)) / (512 * 2 ** zoom);
    this.mercPerPx = 1 / (512 * 2 ** zoom);
    const minL = this.sizing.minPixelLength * mPerPx;
    const minW = this.sizing.minPixelWidth * mPerPx;
    const outlineRgb: [number, number, number] = dark ? [17, 20, 24] : [255, 255, 255];
    const ox = mercX(center.lng);
    const oy = mercY(center.lat);

    // Selected vehicle last, so it draws on top.
    const ordered = this.selectedId
      ? [...vehicles].sort((a, b) => Number(a.id === this.selectedId) - Number(b.id === this.selectedId))
      : vehicles;

    // Per glyph vehicle: 5-vertex fan = 3 fill triangles + 5 edges × 2 outline triangles. Per ribbon
    // vehicle: 2 ribbons × 2 triangles per polyline segment.
    let verts = 0;
    for (const v of ordered) verts += v.shape && v.length >= minL ? (v.shape.length - 1) * 12 : 39;
    const buf = new ArrayBuffer(verts * VERTEX_BYTES);
    const f32 = new Float32Array(buf);
    const u8 = new Uint8Array(buf);
    let vi = 0;
    const put = (x: number, y: number, c: RGBA) => {
      f32[vi * 3] = x - ox;
      f32[vi * 3 + 1] = y - oy;
      const o = vi * VERTEX_BYTES + 8;
      const a = c[3] / 255;
      u8[o] = c[0] * a;
      u8[o + 1] = c[1] * a;
      u8[o + 2] = c[2] * a;
      u8[o + 3] = c[3];
      vi++;
    };

    this.hits = [];
    const quadStrip = (l: Float64Array, r: Float64Array, c: RGBA) => {
      for (let i = 0; i + 3 < l.length; i += 2) {
        put(l[i]!, l[i + 1]!, c);
        put(r[i]!, r[i + 1]!, c);
        put(l[i + 2]!, l[i + 3]!, c);
        put(r[i]!, r[i + 1]!, c);
        put(r[i + 2]!, r[i + 3]!, c);
        put(l[i + 2]!, l[i + 3]!, c);
      }
    };
    for (const v of ordered) {
      const rgb = this.colors.get(v.routeKey) ?? [110, 110, 110];
      const estimated = v.provenance === 'estimated';
      const selected = v.id === this.selectedId;
      if (v.shape && v.length >= minL) {
        // Zoomed in: draw the train along the track.
        const line = new Float64Array(v.shape.length * 2);
        v.shape.forEach(([lon, lat], i) => {
          line[i * 2] = mercX(lon);
          line[i * 2 + 1] = mercY(lat);
        });
        const perM = 1 / (EARTH_CIRCUMFERENCE * Math.cos((v.lat * Math.PI) / 180));
        const hw = (Math.max(v.width, minW) / 2) * perM;
        const lineW = (selected ? 3 : 1.75) * this.mercPerPx;
        const nose = Math.max(v.width, minW) * 0.9 * perM;
        const outer = ribbon(line, hw + lineW, nose);
        const inner = ribbon(line, hw, nose);
        const fill: RGBA = estimated
          ? [
              rgb[0] + (outlineRgb[0] - rgb[0]) * ESTIMATED_TINT,
              rgb[1] + (outlineRgb[1] - rgb[1]) * ESTIMATED_TINT,
              rgb[2] + (outlineRgb[2] - rgb[2]) * ESTIMATED_TINT,
              255,
            ]
          : [...rgb, 255];
        const edge: RGBA = selected ? SELECTED : estimated ? [...rgb, 255] : [...outlineRgb, 255];
        quadStrip(outer.left, outer.right, edge);
        quadStrip(inner.left, inner.right, fill);
        this.hits.push({ v, line, hw: hw + lineW });
        continue;
      }
      const scale = Math.max(1, minL / v.length);
      const outer = vehicleOutline(v, v.length * scale, Math.max(v.width * Math.min(scale, 3), minW));
      const inner = inset(outer, (selected ? 3 : 1.75) * this.mercPerPx);
      const fill: RGBA = estimated
        ? [
            rgb[0] + (outlineRgb[0] - rgb[0]) * ESTIMATED_TINT,
            rgb[1] + (outlineRgb[1] - rgb[1]) * ESTIMATED_TINT,
            rgb[2] + (outlineRgb[2] - rgb[2]) * ESTIMATED_TINT,
            255,
          ]
        : [...rgb, 255];
      const line: RGBA = selected ? SELECTED : estimated ? [...rgb, 255] : [...outlineRgb, 255];
      for (let i = 1; i < 4; i++) {
        put(inner[0]!, inner[1]!, fill);
        put(inner[i * 2]!, inner[i * 2 + 1]!, fill);
        put(inner[(i + 1) * 2]!, inner[(i + 1) * 2 + 1]!, fill);
      }
      for (let i = 0; i < 5; i++) {
        const j = (i + 1) % 5;
        put(outer[i * 2]!, outer[i * 2 + 1]!, line);
        put(outer[j * 2]!, outer[j * 2 + 1]!, line);
        put(inner[j * 2]!, inner[j * 2 + 1]!, line);
        put(outer[i * 2]!, outer[i * 2 + 1]!, line);
        put(inner[j * 2]!, inner[j * 2 + 1]!, line);
        put(inner[i * 2]!, inner[i * 2 + 1]!, line);
      }
      this.hits.push({ v, poly: outer });
    }
    this.layer.setGeometry(buf, vi, [ox, oy]);
  }

  /** Topmost vehicle under a screen point (within a few pixels), for hover and selection. */
  pickAt(x: number, y: number): VehicleState | undefined {
    const ll = this.map.unproject([x, y]);
    const mx = mercX(ll.lng);
    const my = mercY(ll.lat);
    const tol = PICK_TOLERANCE_PX * this.mercPerPx;
    for (let i = this.hits.length - 1; i >= 0; i--) {
      const h = this.hits[i]!;
      if ('poly' in h ? pointInConvex(h.poly, mx, my) : distToPolyline(h.line, mx, my) <= h.hw) return h.v;
    }
    // Near miss: nearest vehicle within tolerance (helps on touch screens and tiny vehicles).
    let best: VehicleState | undefined;
    let bestD = tol;
    for (const h of this.hits) {
      let d = Infinity;
      if ('poly' in h) for (let k = 0; k < h.poly.length; k += 2) d = Math.min(d, Math.hypot(h.poly[k]! - mx, h.poly[k + 1]! - my));
      else d = distToPolyline(h.line, mx, my) - h.hw;
      if (d < bestD) {
        bestD = d;
        best = h.v;
      }
    }
    return best;
  }
}
