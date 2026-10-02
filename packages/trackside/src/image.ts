// Minimal RGBA image helpers (no canvas, so the same code runs in the page, a worker and Node).

/** An RGBA image, 4 bytes per pixel, rows top to bottom (the layout of canvas ImageData). */
export interface Rgba {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export function createRgba(width: number, height: number): Rgba {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A copy of `box` (clamped to the image). */
export function crop(img: Rgba, box: Box): Rgba {
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(img.width, Math.ceil(box.x + box.w));
  const y1 = Math.min(img.height, Math.ceil(box.y + box.h));
  const out = createRgba(Math.max(0, x1 - x0), Math.max(0, y1 - y0));
  for (let y = y0; y < y1; y++)
    out.data.set(
      img.data.subarray((y * img.width + x0) * 4, (y * img.width + x1) * 4),
      (y - y0) * out.width * 4,
    );
  return out;
}

/** Bilinear resize. */
export function resize(img: Rgba, width: number, height: number): Rgba {
  const out = createRgba(width, height);
  const sx = img.width / width;
  const sy = img.height / height;
  const src = img.data;
  const dst = out.data;
  for (let y = 0; y < height; y++) {
    const fy = Math.max(0, (y + 0.5) * sy - 0.5);
    const y0 = Math.min(img.height - 1, Math.floor(fy));
    const y1 = Math.min(img.height - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.max(0, (x + 0.5) * sx - 0.5);
      const x0 = Math.min(img.width - 1, Math.floor(fx));
      const x1 = Math.min(img.width - 1, x0 + 1);
      const wx = fx - x0;
      const a = (y0 * img.width + x0) * 4;
      const b = (y0 * img.width + x1) * 4;
      const c = (y1 * img.width + x0) * 4;
      const d = (y1 * img.width + x1) * 4;
      const o = (y * width + x) * 4;
      for (let k = 0; k < 4; k++)
        dst[o + k] =
          (src[a + k]! * (1 - wx) + src[b + k]! * wx) * (1 - wy)
          + (src[c + k]! * (1 - wx) + src[d + k]! * wx) * wy;
    }
  }
  return out;
}

/** Images side by side, left to right, top-aligned (shorter ones padded with black). */
export function hstack(parts: Rgba[]): Rgba {
  const width = parts.reduce((s, p) => s + p.width, 0);
  const height = parts.reduce((m, p) => Math.max(m, p.height), 0);
  const out = createRgba(width, height);
  let x0 = 0;
  for (const p of parts) {
    for (let y = 0; y < p.height; y++)
      out.data.set(
        p.data.subarray(y * p.width * 4, (y + 1) * p.width * 4),
        (y * width + x0) * 4,
      );
    x0 += p.width;
  }
  return out;
}

/** The image mirrored left to right. */
export function mirror(img: Rgba): Rgba {
  const out = createRgba(img.width, img.height);
  const w = img.width;
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < w; x++)
      out.data.set(
        img.data.subarray((y * w + x) * 4, (y * w + x + 1) * 4),
        (y * w + (w - 1 - x)) * 4,
      );
  return out;
}

/** Luma (BT.601) of each pixel, 0–255. */
export function luma(img: Rgba): Float32Array {
  const n = img.width * img.height;
  const out = new Float32Array(n);
  const d = img.data;
  for (let i = 0; i < n; i++)
    out[i] = 0.299 * d[i * 4]! + 0.587 * d[i * 4 + 1]! + 0.114 * d[i * 4 + 2]!;
  return out;
}
