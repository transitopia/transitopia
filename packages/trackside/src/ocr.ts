// Text reading for car numbers (packages/trackside/README.md#reading-car-numbers): PaddleOCR's PP-OCRv4
// detection and recognition models, run by whichever ONNX Runtime the host has (onnxruntime-web in
// the page, onnxruntime-node in pipelines). This file is only the pre- and post-processing, so it
// stays DOM-free and runtime-agnostic.

import { crop, resize, type Box, type Rgba } from "./image.ts";

/** One ONNX model with a single image input and a single output. */
export interface OnnxModel {
  run(
    input: Float32Array,
    dims: number[],
  ): Promise<{ data: Float32Array; dims: readonly number[] }>;
}

export interface OcrModels {
  det: OnnxModel;
  rec: OnnxModel;
  /** The recogniser's dictionary (ppocr_keys_v1.txt), one character per line. */
  keys: string[];
}

export interface OcrText {
  box: Box;
  /** The unconstrained reading (for logs). */
  text: string;
  /** The reading with only digits allowed (car numbers are digits). */
  digits: string;
  /** Mean probability of the digits read, 0–1. */
  confidence: number;
}

export interface OcrOptions {
  /** Detection tile width in pixels (tiles overlap by `tileOverlap`). */
  tileWidth?: number;
  tileOverlap?: number;
  /** Probability above which a pixel counts as text (DB's `thresh`). */
  pixelThreshold?: number;
  /** Mean probability a text box needs (DB's `box_thresh`). */
  boxThreshold?: number;
  /** How far boxes grow beyond the detected core (DB's `unclip_ratio`). */
  unclipRatio?: number;
  /** Detection runs on the image scaled by this (car numbers are small: ~20–35 px at 1080p). */
  detScale?: number;
}

// PaddleOCR's defaults (tools/infer/utility.py), except smaller tiles for phones.
const DEFAULTS: Required<OcrOptions> = {
  tileWidth: 960,
  tileOverlap: 160,
  pixelThreshold: 0.3,
  boxThreshold: 0.6,
  unclipRatio: 1.6,
  detScale: 1,
};

const REC_HEIGHT = 48;
const REC_MAX_WIDTH = 480;

export class Ocr {
  private readonly models: OcrModels;
  private readonly opts: Required<OcrOptions>;
  /** Output indices of 0–9 in the recogniser's classes (0 is the CTC blank). */
  private readonly digitClass: Map<number, string>;

  constructor(models: OcrModels, opts: OcrOptions = {}) {
    this.models = models;
    this.opts = { ...DEFAULTS, ...opts };
    this.digitClass = new Map();
    models.keys.forEach((k, i) => {
      if (/^[0-9]$/.test(k)) this.digitClass.set(i + 1, k);
    });
  }

  /** Every text in the image, read. Wide images are detected in overlapping tiles. */
  async read(img: Rgba): Promise<OcrText[]> {
    const boxes = await this.detect(img);
    const out: OcrText[] = [];
    for (const box of boxes)
      out.push({ box, ...(await this.recognise(crop(img, box))) });
    return out;
  }

  /** Text boxes, in image coordinates, left to right. */
  async detect(img: Rgba): Promise<Box[]> {
    const { tileWidth, tileOverlap } = this.opts;
    const boxes: Box[] = [];
    const step = Math.max(1, tileWidth - tileOverlap);
    for (let x = 0; x < img.width; x += step) {
      const w = Math.min(tileWidth, img.width - x);
      if (x > 0 && w <= tileOverlap) break;
      for (const b of await this.detectTile(
        crop(img, { x, y: 0, w, h: img.height }),
      ))
        boxes.push({ ...b, x: b.x + x });
      if (x + w >= img.width) break;
    }
    return dedupe(boxes).sort((a, b) => a.x - b.x);
  }

  private async detectTile(tile: Rgba): Promise<Box[]> {
    // The model wants sides that are multiples of 32.
    const k = this.opts.detScale;
    const W = Math.max(32, Math.round((tile.width * k) / 32) * 32);
    const H = Math.max(32, Math.round((tile.height * k) / 32) * 32);
    const img = resize(tile, W, H);
    // ImageNet normalisation, applied to BGR as PaddleOCR does (it reads images with OpenCV).
    const mean = [0.485, 0.456, 0.406];
    const std = [0.229, 0.224, 0.225];
    const input = new Float32Array(3 * W * H);
    const plane = W * H;
    for (let i = 0; i < plane; i++)
      for (let c = 0; c < 3; c++) {
        const v = img.data[i * 4 + (2 - c)]! / 255;
        input[c * plane + i] = (v - mean[c]!) / std[c]!;
      }
    const { data, dims } = await this.models.det.run(input, [1, 3, H, W]);
    const oh = dims[2] ?? H;
    const ow = dims[3] ?? W;
    const sx = tile.width / ow;
    const sy = tile.height / oh;
    return components(data, ow, oh, this.opts).map((b) => ({
      x: b.x * sx,
      y: b.y * sy,
      w: b.w * sx,
      h: b.h * sy,
    }));
  }

  /** Read one cropped line of text. */
  async recognise(
    line: Rgba,
  ): Promise<{ text: string; digits: string; confidence: number }> {
    if (line.width < 2 || line.height < 2)
      return { text: "", digits: "", confidence: 0 };
    const W = Math.min(
      REC_MAX_WIDTH,
      Math.max(16, Math.round((REC_HEIGHT * line.width) / line.height)),
    );
    const img = resize(line, W, REC_HEIGHT);
    const plane = W * REC_HEIGHT;
    const input = new Float32Array(3 * plane);
    for (let i = 0; i < plane; i++)
      for (let c = 0; c < 3; c++)
        input[c * plane + i] = (img.data[i * 4 + (2 - c)]! / 255 - 0.5) / 0.5;
    const { data, dims } = await this.models.rec.run(input, [
      1,
      3,
      REC_HEIGHT,
      W,
    ]);
    const steps = dims[1] ?? 0;
    const classes = dims[2] ?? 0;
    return decode(data, steps, classes, this.models.keys, this.digitClass);
  }
}

/** Greedy CTC decoding, both unconstrained and with only digits (and blank) allowed. */
export function decode(
  probs: Float32Array,
  steps: number,
  classes: number,
  keys: string[],
  digitClass: Map<number, string>,
): { text: string; digits: string; confidence: number } {
  let text = "";
  let digits = "";
  let lastAny = 0;
  let lastDigit = 0;
  let sum = 0;
  let n = 0;
  for (let t = 0; t < steps; t++) {
    const row = t * classes;
    let best = 0;
    for (let c = 1; c < classes; c++)
      if (probs[row + c]! > probs[row + best]!) best = c;
    if (best !== 0 && best !== lastAny) text += keys[best - 1] ?? " ";
    lastAny = best;
    let bestDigit = 0;
    for (const c of digitClass.keys())
      if (probs[row + c]! > probs[row + bestDigit]!) bestDigit = c;
    if (bestDigit !== 0 && bestDigit !== lastDigit) {
      digits += digitClass.get(bestDigit);
      sum += probs[row + bestDigit]!;
      n++;
    }
    lastDigit = bestDigit;
  }
  return { text, digits, confidence: n ? sum / n : 0 };
}

/** Bounding boxes of connected text regions in a probability map (DB post-processing, axis-aligned). */
export function components(
  prob: Float32Array,
  width: number,
  height: number,
  opts: Required<OcrOptions>,
): Box[] {
  const seen = new Uint8Array(width * height);
  const stack = new Int32Array(width * height);
  const boxes: Box[] = [];
  for (let start = 0; start < width * height; start++) {
    if (seen[start] || prob[start]! < opts.pixelThreshold) continue;
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    let x0 = width,
      y0 = height,
      x1 = 0,
      y1 = 0,
      sum = 0,
      count = 0;
    while (top) {
      const i = stack[--top]!;
      const x = i % width;
      const y = (i - x) / width;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
      sum += prob[i]!;
      count++;
      for (const j of [i - 1, i + 1, i - width, i + width]) {
        if (j < 0 || j >= width * height || seen[j]) continue;
        if ((j === i - 1 && x === 0) || (j === i + 1 && x === width - 1))
          continue;
        if (prob[j]! < opts.pixelThreshold) continue;
        seen[j] = 1;
        stack[top++] = j;
      }
    }
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    if (Math.min(w, h) < 3 || sum / count < opts.boxThreshold) continue;
    // DB shrinks text regions when training, so grow them back: by area × ratio / perimeter.
    const d = (w * h * opts.unclipRatio) / (2 * (w + h));
    const bx = Math.max(0, x0 - d);
    const by = Math.max(0, y0 - d);
    boxes.push({
      x: bx,
      y: by,
      w: Math.min(width, x1 + 1 + d) - bx,
      h: Math.min(height, y1 + 1 + d) - by,
    });
  }
  return boxes;
}

/** Drop boxes found twice in overlapping tiles (keeping the larger). */
function dedupe(boxes: Box[]): Box[] {
  const sorted = [...boxes].sort((a, b) => b.w * b.h - a.w * a.h);
  const kept: Box[] = [];
  for (const b of sorted)
    if (!kept.some((k) => overlap(k, b) > 0.5 * Math.min(area(k), area(b))))
      kept.push(b);
  return kept;
}

const area = (b: Box) => b.w * b.h;

function overlap(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}
