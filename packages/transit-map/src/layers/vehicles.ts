// Animated vehicles. Each is a pointed rectangle at true scale, enlarged to a minimum pixel size
// when zoomed out (packages/transit-map/README.md#rendering), drawn by GlPolygonLayer. Observed and
// interpolated positions are solid route colour with a thin darker edge; estimated ones are translucent
// with a white edge, so an estimate never looks observed. Picking is done on the CPU.

import type { Map as MlMap } from "maplibre-gl";
import type { VehicleState } from "@transitopia/transit-core/schedule/engine.ts";
import type { KinematicsConfig } from "@transitopia/transit-core/movement/kinematics.ts";
import { GlPolygonLayer, VERTEX_BYTES } from "./gl-polygons.ts";
import { VEHICLES_BEFORE_LAYER } from "./static.ts";
import {
  EARTH_CIRCUMFERENCE,
  distToPolyline,
  extendEnds,
  hexToRgb,
  inset,
  mercX,
  mercY,
  pointInConvex,
  ribbon,
  vehicleOutline,
} from "./vehicle-geometry.ts";

type RGBA = [number, number, number, number];

const LAYER_ID = "vehicles";
const SELECTED: RGBA = [255, 64, 129, 255];
/** Estimated vehicles are filled with the route colour at this opacity. */
const ESTIMATED_OPACITY = 0.62;
const ESTIMATED_EDGE: RGBA = [255, 255, 255, 255];
/** Observed vehicles' edge: the route colour darkened by this factor (light theme)… */
const OBSERVED_EDGE_SHADE = 0.65;
/** …or a near-black edge (dark theme). */
const OBSERVED_EDGE_DARK: RGBA = [11, 18, 32, 255];
/** Edge widths in pixels. */
const EDGE_PX = { observed: 1.25, estimated: 2, selected: 3 };
const PICK_TOLERANCE_PX = 5;

export class VehicleLayer {
  private layer = new GlPolygonLayer(LAYER_ID);
  private colors = new Map<string, [number, number, number]>();
  private hits: (
    | { v: VehicleState; poly: Float64Array }
    | { v: VehicleState; line: Float64Array; hw: number }
  )[] = [];
  private mercPerPx = 0;
  selectedId: string | undefined;

  private map: MlMap;
  private sizing: KinematicsConfig["sizing"];

  constructor(map: MlMap, sizing: KinematicsConfig["sizing"]) {
    this.map = map;
    this.sizing = sizing;
  }

  /** Add (or re-add after a style change) beneath the station labels. */
  attach(): void {
    const before =
      this.map.getLayer(VEHICLES_BEFORE_LAYER) ?
        VEHICLES_BEFORE_LAYER
      : undefined;
    // setStyle keeps custom layers, but the route/track layers are re-added above them: move it back.
    if (this.map.getLayer(LAYER_ID)) this.map.moveLayer(LAYER_ID, before);
    else this.map.addLayer(this.layer, before);
  }

  detach(): void {
    if (this.map.getLayer(LAYER_ID)) this.map.removeLayer(LAYER_ID);
  }

  setRouteColors(routes: { key: string; color: string }[]): void {
    for (const r of routes) this.colors.set(r.key, hexToRgb(r.color));
  }

  update(vehicles: VehicleState[], dark: boolean): void {
    const zoom = this.map.getZoom();
    const center = this.map.getCenter();
    const mPerPx =
      (EARTH_CIRCUMFERENCE * Math.cos((center.lat * Math.PI) / 180))
      / (512 * 2 ** zoom);
    this.mercPerPx = 1 / (512 * 2 ** zoom);
    const minL = this.sizing.minPixelLength * mPerPx;
    const minW = this.sizing.minPixelWidth * mPerPx;
    const ox = mercX(center.lng);
    const oy = mercY(center.lat);

    // Selected vehicle last, so it draws on top.
    const ordered =
      this.selectedId ?
        [...vehicles].sort(
          (a, b) =>
            Number(a.id === this.selectedId) - Number(b.id === this.selectedId),
        )
      : vehicles;

    // Per glyph vehicle: 5-vertex fan = 3 fill triangles + 5 edges × 2 outline triangles. Per ribbon
    // vehicle: fill + 2 edge strips × 2 triangles per polyline segment, + 2 end caps × 2 triangles.
    let verts = 0;
    for (const v of ordered)
      verts +=
        v.shape && v.length >= minL ? (v.shape.length - 1) * 18 + 12 : 39;
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
      const estimated = v.provenance === "estimated";
      const selected = v.id === this.selectedId;
      const fill: RGBA =
        estimated ?
          [...rgb, Math.round(255 * ESTIMATED_OPACITY)]
        : [...rgb, 255];
      const edge: RGBA =
        selected ? SELECTED
        : estimated ? ESTIMATED_EDGE
        : dark ? OBSERVED_EDGE_DARK
        : [
            rgb[0] * OBSERVED_EDGE_SHADE,
            rgb[1] * OBSERVED_EDGE_SHADE,
            rgb[2] * OBSERVED_EDGE_SHADE,
            255,
          ];
      const edgeW =
        (selected ? EDGE_PX.selected
        : estimated ? EDGE_PX.estimated
        : EDGE_PX.observed) * this.mercPerPx;
      if (v.shape && v.length >= minL) {
        // Zoomed in: draw the train along the track.
        const line = new Float64Array(v.shape.length * 2);
        v.shape.forEach(([lon, lat], i) => {
          line[i * 2] = mercX(lon);
          line[i * 2 + 1] = mercY(lat);
        });
        const perM =
          1 / (EARTH_CIRCUMFERENCE * Math.cos((v.lat * Math.PI) / 180));
        const hw = (Math.max(v.width, minW) / 2) * perM;
        const nose = Math.max(v.width, minW) * 0.9 * perM;
        const inner = ribbon(line, hw, nose);
        // The edge is a ring around the fill (the fill may be translucent): the outer ribbon runs
        // edgeW past both ends of the train.
        const outer = ribbon(extendEnds(line, edgeW), hw + edgeW, nose);
        quadStrip(outer.left, inner.left, edge);
        quadStrip(inner.right, outer.right, edge);
        const last = inner.left.length - 2;
        for (const i of [0, last])
          quadStrip(
            Float64Array.of(
              outer.left[i]!,
              outer.left[i + 1]!,
              inner.left[i]!,
              inner.left[i + 1]!,
            ),
            Float64Array.of(
              outer.right[i]!,
              outer.right[i + 1]!,
              inner.right[i]!,
              inner.right[i + 1]!,
            ),
            edge,
          );
        quadStrip(inner.left, inner.right, fill);
        this.hits.push({ v, line, hw: hw + edgeW });
        continue;
      }
      const scale = Math.max(1, minL / v.length);
      const outer = vehicleOutline(
        v,
        v.length * scale,
        Math.max(v.width * Math.min(scale, 3), minW),
      );
      const inner = inset(outer, edgeW);
      for (let i = 1; i < 4; i++) {
        put(inner[0]!, inner[1]!, fill);
        put(inner[i * 2]!, inner[i * 2 + 1]!, fill);
        put(inner[(i + 1) * 2]!, inner[(i + 1) * 2 + 1]!, fill);
      }
      for (let i = 0; i < 5; i++) {
        const j = (i + 1) % 5;
        put(outer[i * 2]!, outer[i * 2 + 1]!, edge);
        put(outer[j * 2]!, outer[j * 2 + 1]!, edge);
        put(inner[j * 2]!, inner[j * 2 + 1]!, edge);
        put(outer[i * 2]!, outer[i * 2 + 1]!, edge);
        put(inner[j * 2]!, inner[j * 2 + 1]!, edge);
        put(inner[i * 2]!, inner[i * 2 + 1]!, edge);
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
      if (
        "poly" in h ?
          pointInConvex(h.poly, mx, my)
        : distToPolyline(h.line, mx, my) <= h.hw
      )
        return h.v;
    }
    // Near miss: nearest vehicle within tolerance (helps on touch screens and tiny vehicles).
    let best: VehicleState | undefined;
    let bestD = tol;
    for (const h of this.hits) {
      let d = Infinity;
      if ("poly" in h)
        for (let k = 0; k < h.poly.length; k += 2)
          d = Math.min(d, Math.hypot(h.poly[k]! - mx, h.poly[k + 1]! - my));
      else d = distToPolyline(h.line, mx, my) - h.hw;
      if (d < bestD) {
        bestD = d;
        best = h.v;
      }
    }
    return best;
  }
}
