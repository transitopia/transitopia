// Vehicle trails: the layers panel's Route lines "Trace" (packages/transit-map/README.md#rendering).
// As vehicles move in view they leave thin, faint lines behind, wobbling a few pixels either side of
// their path, so a route that many vehicles run along builds up thicker and brighter where trails
// overlap. Trails are kept in world space (relative to an origin, like gl-polygons.ts), so they stay
// put as the map moves, in a ring of segments drawn as instanced quads a fixed screen width wide.
// Only vehicles in view leave trails; `clear` starts again (a seek, or Trace switched off).

import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MlMap,
} from "maplibre-gl";
import type { VehicleState } from "@transitopia/transit-core/schedule/engine.ts";
import type { RouteMode } from "@transitopia/transit-core/plan/types.ts";
import { compile, multiply } from "./gl-polygons.ts";
import { mercX, mercY } from "./vehicle-geometry.ts";

const LAYER_ID = "vehicle-trails";
/** Trail colours by mode group (bus, train, ferry), per theme: bright, drawn at TRAIL_OPACITY. */
const COLORS = {
  dark: [
    [255, 184, 28],
    [255, 64, 170],
    [40, 220, 255],
  ],
  light: [
    [235, 110, 0],
    [214, 0, 120],
    [0, 135, 215],
  ],
} as const;
const MODE_GROUP: Record<RouteMode, number> = {
  bus: 0,
  skytrain: 1,
  rail: 1,
  ferry: 2,
};

/** A mode's trail colour (RGB 0–255): vehicles take it too while route lines aren't drawn. */
export function modeColor(
  mode: RouteMode,
  dark: boolean,
): readonly [number, number, number] {
  return COLORS[dark ? "dark" : "light"][MODE_GROUP[mode]]!;
}
const TRAIL_OPACITY = 0.1;
/** Line width, CSS px. */
const WIDTH_PX = 1.25;
/** A vehicle adds a segment once it has moved this far (px at the zoom then)… */
const MIN_STEP_PX = 2;
/** …and starts a new trail after a jump further than this, or a gap in time longer than MAX_GAP_MS. */
const MAX_STEP_PX = 250;
const MAX_GAP_MS = 10 * 60_000;
/** The wobble: up to this far either side of the path (px), in waves of these lengths (px). */
const WOBBLE_PX = 4;
const WOBBLE_WAVES_PX = [170, 61];
/** Segments kept: the ring grows to this, then the oldest go (20 bytes each). */
const INITIAL_SEGMENTS = 1 << 15;
const MAX_SEGMENTS = 1 << 20;
/** Per segment: from x, y, to x, y (mercator, relative to the origin), mode group. */
const FLOATS = 5;

const VERTEX_SHADER = `#version 300 es
uniform mat4 u_matrix;
uniform vec2 u_half;
uniform float u_half_width;
uniform vec3 u_colors[3];
uniform float u_opacity;
in vec2 a_from;
in vec2 a_to;
in float a_mode;
out vec4 v_color;
out float v_across;
void main() {
  // A quad per segment (triangle strip): corners 0, 1 at its start, 2, 3 at its end.
  float along = float(gl_VertexID >> 1);
  float side = (gl_VertexID & 1) == 0 ? -1.0 : 1.0;
  vec4 a = u_matrix * vec4(a_from, 0.0, 1.0);
  vec4 b = u_matrix * vec4(a_to, 0.0, 1.0);
  vec2 d = (b.xy / b.w - a.xy / a.w) * u_half;
  float len = length(d);
  vec2 n = len > 0.0 ? vec2(-d.y, d.x) / len : vec2(0.0, 1.0);
  vec4 p = mix(a, b, along);
  // Half a pixel more each side to antialias the edge.
  float reach = u_half_width + 0.5;
  p.xy += n * side * reach / u_half * p.w;
  gl_Position = p;
  v_across = side * reach;
  v_color = vec4(u_colors[int(a_mode)], 1.0) * u_opacity;
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform float u_half_width;
in vec4 v_color;
in float v_across;
out vec4 fragColor;
void main() {
  fragColor = v_color * clamp(u_half_width + 0.5 - abs(v_across), 0.0, 1.0);
}`;

/** Where a vehicle's trail has got to. */
interface Trail {
  /** Its position at the last segment (mercator). */
  x: number;
  y: number;
  /** The end of the last segment: that position plus the wobble (mercator). */
  wx: number;
  wy: number;
  /** How far it has travelled (px at the zoom then), for its wobble. */
  s: number;
  /** Its wobble's phases. */
  phase: number[];
  /** When it was last there (epoch ms, the shown time). */
  t: number;
}

export class TraceLayer implements CustomLayerInterface {
  readonly id = LAYER_ID;
  readonly type = "custom" as const;
  readonly renderingMode = "2d" as const;
  private map: MlMap;
  private program: WebGLProgram | undefined;
  private buffer: WebGLBuffer | undefined;
  private vao: WebGLVertexArrayObject | undefined;
  private u: Record<string, WebGLUniformLocation | null> = {};
  /** The segments (a ring once it's MAX_SEGMENTS long), and how many have been added. */
  private data = new Float32Array(INITIAL_SEGMENTS * FLOATS);
  private added = 0;
  /** How many of `added` the GPU's buffer has, and how many segments it has room for. */
  private uploaded = 0;
  private gpuCapacity = 0;
  private origin: [number, number] | undefined;
  private trails = new Map<string, Trail>();
  dark = false;

  constructor(map: MlMap) {
    this.map = map;
  }

  /** Add (or re-add after a style change) beneath the layer `before` (the vehicles). */
  attach(before: string | undefined): void {
    if (before !== undefined && !this.map.getLayer(before)) before = undefined;
    if (this.map.getLayer(LAYER_ID)) this.map.moveLayer(LAYER_ID, before);
    else this.map.addLayer(this, before);
  }

  detach(): void {
    if (this.map.getLayer(LAYER_ID)) this.map.removeLayer(LAYER_ID);
  }

  /** Forget every trail. */
  clear(): void {
    this.added = this.uploaded = 0;
    this.origin = undefined;
    this.trails.clear();
    this.map.triggerRepaint();
  }

  /**
   * Extend the trails of the vehicles `inView` to where they are at `t`. A vehicle out of view
   * leaves none and is forgotten, so coming back into view doesn't join it across.
   */
  record(
    vehicles: readonly VehicleState[],
    t: number,
    inView: (v: VehicleState) => boolean,
  ): void {
    const mercPerPx = 1 / (512 * 2 ** this.map.getZoom());
    const seen = new Map<string, Trail>();
    const before = this.added;
    for (const v of vehicles) {
      if (!inView(v)) continue;
      const key = `${v.feed}|${v.id}`;
      const x = mercX(v.lon);
      const y = mercY(v.lat);
      const was = this.trails.get(key);
      const px = was ? Math.hypot(x - was.x, y - was.y) / mercPerPx : 0;
      if (!was || px > MAX_STEP_PX || Math.abs(t - was.t) > MAX_GAP_MS) {
        const phase = Array.from(
          { length: WOBBLE_WAVES_PX.length * 2 },
          () => Math.random() * 2 * Math.PI,
        );
        const [dx, dy] = wobble(0, phase);
        seen.set(key, {
          x,
          y,
          wx: x + dx * mercPerPx,
          wy: y + dy * mercPerPx,
          s: 0,
          phase,
          t,
        });
        continue;
      }
      seen.set(key, was);
      if (px < MIN_STEP_PX) continue;
      const s = was.s + px;
      const [dx, dy] = wobble(s, was.phase);
      const wx = x + dx * mercPerPx;
      const wy = y + dy * mercPerPx;
      this.push(was.wx, was.wy, wx, wy, MODE_GROUP[v.mode]);
      Object.assign(was, { x, y, wx, wy, s, t });
    }
    this.trails = seen;
    if (this.added !== before) this.map.triggerRepaint();
  }

  private push(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    mode: number,
  ): void {
    this.origin ??= [x0, y0];
    const [ox, oy] = this.origin;
    const capacity = this.data.length / FLOATS;
    if (this.added === capacity && capacity < MAX_SEGMENTS) {
      const grown = new Float32Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    const o = (this.added % (this.data.length / FLOATS)) * FLOATS;
    this.data[o] = x0 - ox;
    this.data[o + 1] = y0 - oy;
    this.data[o + 2] = x1 - ox;
    this.data[o + 3] = y1 - oy;
    this.data[o + 4] = mode;
    this.added++;
  }

  onAdd(_map: MlMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    if (!(gl instanceof WebGL2RenderingContext))
      throw new Error("WebGL2 is required");
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error(`Program link failed: ${gl.getProgramInfoLog(program)}`);
    this.program = program;
    for (const name of [
      "u_matrix",
      "u_half",
      "u_half_width",
      "u_colors",
      "u_opacity",
    ])
      this.u[name] = gl.getUniformLocation(program, name);
    this.buffer = gl.createBuffer()!;
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    const stride = FLOATS * 4;
    for (const [name, size, offset] of [
      ["a_from", 2, 0],
      ["a_to", 2, 8],
      ["a_mode", 1, 16],
    ] as const) {
      const loc = gl.getAttribLocation(program, name);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
      gl.vertexAttribDivisor(loc, 1);
    }
    gl.bindVertexArray(null);
    // A new buffer: everything is uploaded again.
    this.gpuCapacity = 0;
  }

  onRemove(
    _map: MlMap,
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    const g = gl as WebGL2RenderingContext;
    if (this.buffer) g.deleteBuffer(this.buffer);
    if (this.vao) g.deleteVertexArray(this.vao);
    if (this.program) g.deleteProgram(this.program);
    this.buffer = this.vao = this.program = undefined;
  }

  /** Bring the GPU's copy up to date: the new segments, or all of them in a new, larger buffer. */
  private upload(g: WebGL2RenderingContext): void {
    const capacity = this.data.length / FLOATS;
    g.bindBuffer(g.ARRAY_BUFFER, this.buffer!);
    if (
      this.gpuCapacity !== capacity
      || this.added - this.uploaded > capacity
    ) {
      g.bufferData(g.ARRAY_BUFFER, this.data, g.DYNAMIC_DRAW);
      this.gpuCapacity = capacity;
    } else {
      // The ring's new stretch, in up to two pieces where it wraps.
      for (let i = this.uploaded; i < this.added;) {
        const at = i % capacity;
        const n = Math.min(this.added - i, capacity - at);
        g.bufferSubData(
          g.ARRAY_BUFFER,
          at * FLOATS * 4,
          this.data,
          at * FLOATS,
          n * FLOATS,
        );
        i += n;
      }
    }
    this.uploaded = this.added;
  }

  render(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    options: CustomRenderMethodInput,
  ): void {
    const g = gl as WebGL2RenderingContext;
    const count = Math.min(this.added, this.data.length / FLOATS);
    if (!this.program || !this.vao || !this.origin || count === 0) return;
    if (this.uploaded !== this.added || this.gpuCapacity === 0) this.upload(g);
    const [ox, oy] = this.origin;
    const translate = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, ox, oy, 0, 1];
    const matrix = multiply(
      options.defaultProjectionData.mainMatrix as ArrayLike<number>,
      translate,
    );
    g.useProgram(this.program);
    g.uniformMatrix4fv(this.u.u_matrix!, false, new Float32Array(matrix));
    g.uniform2f(
      this.u.u_half!,
      g.drawingBufferWidth / 2,
      g.drawingBufferHeight / 2,
    );
    g.uniform1f(
      this.u.u_half_width!,
      (WIDTH_PX * this.map.getPixelRatio()) / 2,
    );
    g.uniform3fv(
      this.u.u_colors!,
      COLORS[this.dark ? "dark" : "light"].flat().map((c) => c / 255),
    );
    g.uniform1f(this.u.u_opacity!, TRAIL_OPACITY);
    g.bindVertexArray(this.vao);
    g.enable(g.BLEND);
    // Dark: trails add up to a glow; light: they darken like ink.
    if (this.dark) g.blendFuncSeparate(g.ONE, g.ONE, g.ZERO, g.ONE);
    else g.blendFunc(g.ONE, g.ONE_MINUS_SRC_ALPHA);
    g.disable(g.DEPTH_TEST);
    g.drawArraysInstanced(g.TRIANGLE_STRIP, 0, 4, count);
    g.bindVertexArray(null);
  }
}

/** A trail's offset from its path (px) after travelling `s` px: a sum of waves in x and y. */
function wobble(s: number, phase: readonly number[]): [number, number] {
  let dx = 0;
  let dy = 0;
  const n = WOBBLE_WAVES_PX.length;
  WOBBLE_WAVES_PX.forEach((wave, i) => {
    const k = (2 * Math.PI) / wave;
    // Longer waves wobble further.
    const a = (WOBBLE_PX * (n - i)) / ((n * (n + 1)) / 2);
    dx += a * Math.sin(s * k + phase[i]!);
    dy += a * Math.sin(s * k + phase[n + i]!);
  });
  return [dx, dy];
}
