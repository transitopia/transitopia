// A minimal MapLibre custom layer that draws coloured triangles (vehicles) with WebGL, using only
// MapLibre's public CustomLayerInterface. Geometry is supplied in web-mercator units relative to an
// origin near the viewport, and the origin is folded into the matrix in float64 on the CPU, so
// vertices keep sub-centimetre precision at any zoom ("relative to centre" rendering).
// Mercator projection only.

import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MlMap,
} from "maplibre-gl";

const VERTEX_SHADER = `#version 300 es
uniform mat4 u_matrix;
in vec2 a_pos;
in vec4 a_color;
out vec4 v_color;
void main() {
  gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
  v_color = a_color;
}`;

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;
in vec4 v_color;
out vec4 fragColor;
void main() {
  fragColor = v_color;
}`;

/** Interleaved vertex: x, y (float32 mercator offsets) + rgba (uint8, premultiplied). */
export const VERTEX_BYTES = 12;

function compile(
  gl: WebGL2RenderingContext,
  type: number,
  src: string,
): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
    throw new Error(`Shader compile failed: ${gl.getShaderInfoLog(s)}`);
  return s;
}

/** out = a × b for column-major 4×4 matrices, in float64. */
function multiply(a: ArrayLike<number>, b: ArrayLike<number>): Float64Array {
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!;
      out[c * 4 + r] = s;
    }
  }
  return out;
}

export class GlPolygonLayer implements CustomLayerInterface {
  readonly type = "custom" as const;
  readonly renderingMode = "2d" as const;
  private gl: WebGL2RenderingContext | undefined;
  private program: WebGLProgram | undefined;
  private buffer: WebGLBuffer | undefined;
  private vao: WebGLVertexArrayObject | undefined;
  private uMatrix: WebGLUniformLocation | null = null;
  private data = new ArrayBuffer(0);
  private vertexCount = 0;
  private origin: [number, number] = [0, 0];
  private dirty = false;
  private map: MlMap | undefined;

  constructor(readonly id: string) {}

  onAdd(map: MlMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    if (!(gl instanceof WebGL2RenderingContext))
      throw new Error("WebGL2 is required");
    this.map = map;
    this.gl = gl;
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error(`Program link failed: ${gl.getProgramInfoLog(program)}`);
    this.program = program;
    this.uMatrix = gl.getUniformLocation(program, "u_matrix");
    this.buffer = gl.createBuffer()!;
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    const aPos = gl.getAttribLocation(program, "a_pos");
    const aColor = gl.getAttribLocation(program, "a_color");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, VERTEX_BYTES, 0);
    gl.enableVertexAttribArray(aColor);
    gl.vertexAttribPointer(aColor, 4, gl.UNSIGNED_BYTE, true, VERTEX_BYTES, 8);
    gl.bindVertexArray(null);
    this.dirty = true;
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

  /** Replace the geometry. `data` holds `vertexCount` interleaved vertices (see VERTEX_BYTES). */
  setGeometry(
    data: ArrayBuffer,
    vertexCount: number,
    origin: [number, number],
  ): void {
    this.data = data;
    this.vertexCount = vertexCount;
    this.origin = origin;
    this.dirty = true;
    this.map?.triggerRepaint();
  }

  render(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    options: CustomRenderMethodInput,
  ): void {
    const g = gl as WebGL2RenderingContext;
    if (!this.program || !this.vao || !this.buffer || this.vertexCount === 0)
      return;
    if (this.dirty) {
      g.bindBuffer(g.ARRAY_BUFFER, this.buffer);
      g.bufferData(g.ARRAY_BUFFER, this.data, g.DYNAMIC_DRAW);
      this.dirty = false;
    }
    const translate = [
      1,
      0,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      0,
      1,
      0,
      this.origin[0],
      this.origin[1],
      0,
      1,
    ];
    const matrix = multiply(
      options.defaultProjectionData.mainMatrix as ArrayLike<number>,
      translate,
    );
    g.useProgram(this.program);
    g.uniformMatrix4fv(this.uMatrix, false, new Float32Array(matrix));
    g.bindVertexArray(this.vao);
    g.enable(g.BLEND);
    g.blendFunc(g.ONE, g.ONE_MINUS_SRC_ALPHA);
    g.disable(g.DEPTH_TEST);
    g.drawArrays(g.TRIANGLES, 0, this.vertexCount);
    g.bindVertexArray(null);
  }
}
