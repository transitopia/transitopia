// The /trackside car-number reader, in a worker so the camera loop never waits for it
// (packages/trackside/README.md#reading-car-numbers). onnxruntime-web and the models come from jsDelivr at
// pinned versions (packages/trackside/src/read.ts), so none of it is in the site's bundles; the
// models are kept in Cache Storage after the first download (~16 MB). Crops come back as pixels:
// the page encodes them (OffscreenCanvas.convertToBlob never resolved in a worker while the camera
// ran, in Chrome).

import { Ocr, type OnnxModel } from "@transitopia/trackside/ocr.ts";
import {
  MODEL_URLS,
  OCR_OPTIONS,
  ORT_WEB,
  parseKeys,
  readPass,
} from "@transitopia/trackside/read.ts";
import { uncertainTexts } from "@transitopia/trackside/cars.ts";
import {
  crop,
  resize,
  type Box,
  type Rgba,
} from "@transitopia/trackside/image.ts";
import type { DetectedPass } from "@transitopia/trackside/detector.ts";

/** A reading with its crop as pixels (the page encodes it as JPEG). */
export interface WorkerReading {
  number: string;
  confidence: number;
  reads: number;
  image: Rgba;
}

export type OcrRequest =
  | { type: "load" }
  | { type: "read"; id: string; pass: DetectedPass; thumbnailHeight: number };

export type OcrResponse =
  | { type: "progress"; loaded: number; total: number }
  | { type: "ready" }
  | { type: "error"; id?: string | undefined; message: string }
  | {
      type: "result";
      id: string;
      cars: WorkerReading[];
      uncertain: WorkerReading[];
      /** The whole train, small, for the page's debug view only (never uploaded). */
      thumbnail: Rgba;
      ms: number;
    };

/** The part of onnxruntime-web's API used here (it's loaded from the CDN, so no package types). */
interface OrtWeb {
  env: { wasm: { wasmPaths: string; numThreads: number } };
  InferenceSession: {
    create(model: Uint8Array): Promise<{
      inputNames: readonly string[];
      outputNames: readonly string[];
      run(
        feeds: Record<string, unknown>,
      ): Promise<Record<string, { data: unknown; dims: readonly number[] }>>;
    }>;
  };
  Tensor: new (type: "float32", data: Float32Array, dims: number[]) => unknown;
}

const CACHE = "transitopia-trackside-ocr";
let ocr: Promise<Ocr> | undefined;

const post = (msg: OcrResponse, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(msg, transfer);

// One pass at a time: reading is CPU-bound, and queued panoramas are large.
let queue: Promise<void> = Promise.resolve();
self.onmessage = (e: MessageEvent<OcrRequest>) => {
  queue = queue.then(() => handle(e.data));
};

async function handle(msg: OcrRequest): Promise<void> {
  try {
    ocr ??= load();
    const reader = await ocr;
    if (msg.type === "load") return;
    const t0 = performance.now();
    const img = msg.pass.panorama;
    const { cars, texts } = await readPass(reader, msg.pass);
    const reading = (
      number: string,
      confidence: number,
      reads: number,
      box: Box,
    ) => ({
      number,
      confidence: round(confidence),
      reads,
      image: crop(img, pad(box, img)),
    });
    const result: OcrResponse = {
      type: "result",
      id: msg.id,
      cars: cars.map((c) => reading(c.number, c.confidence, c.reads, c.box)),
      uncertain: uncertainTexts(texts, img.height).map((t) =>
        reading(t.digits, t.confidence, 1, t.box),
      ),
      thumbnail: resize(
        img,
        Math.max(1, Math.round((img.width * msg.thumbnailHeight) / img.height)),
        msg.thumbnailHeight,
      ),
      ms: Math.round(performance.now() - t0),
    };
    post(result, [
      ...result.cars.map((c) => c.image.data.buffer),
      ...result.uncertain.map((c) => c.image.data.buffer),
      result.thumbnail.data.buffer,
    ]);
  } catch (err) {
    if (msg.type === "load") ocr = undefined;
    post({
      type: "error",
      id: msg.type === "read" ? msg.id : undefined,
      message: (err as Error).message,
    });
  }
}

async function load(): Promise<Ocr> {
  const ort = (await import(
    /* @vite-ignore */ `${ORT_WEB}ort.wasm.min.mjs`
  )) as OrtWeb;
  ort.env.wasm.wasmPaths = ORT_WEB;
  // Threads need cross-origin isolation, which the site doesn't have.
  ort.env.wasm.numThreads = 1;
  const sizes = { det: 4_745_517, rec: 10_822_323, keys: 26_249 };
  const total = sizes.det + sizes.rec + sizes.keys;
  const loaded = { det: 0, rec: 0, keys: 0 };
  const progress = (k: keyof typeof loaded) => (n: number) => {
    loaded[k] = n;
    post({
      type: "progress",
      loaded: loaded.det + loaded.rec + loaded.keys,
      total,
    });
  };
  const [det, rec, keys] = await Promise.all([
    fetchCached(MODEL_URLS.det, progress("det")),
    fetchCached(MODEL_URLS.rec, progress("rec")),
    fetchCached(MODEL_URLS.keys, progress("keys")),
  ]);
  const model = async (bytes: Uint8Array): Promise<OnnxModel> => {
    const s = await ort.InferenceSession.create(bytes);
    return {
      async run(input, dims) {
        const out = await s.run({
          [s.inputNames[0]!]: new ort.Tensor("float32", input, dims),
        });
        const o = out[s.outputNames[0]!]!;
        return { data: o.data as Float32Array, dims: o.dims };
      },
    };
  };
  const reader = new Ocr(
    {
      det: await model(det),
      rec: await model(rec),
      keys: parseKeys(new TextDecoder().decode(keys)),
    },
    OCR_OPTIONS,
  );
  post({ type: "ready" });
  return reader;
}

/** A file from Cache Storage, or downloaded (with progress) and cached. */
async function fetchCached(
  url: string,
  onProgress: (bytes: number) => void,
): Promise<Uint8Array> {
  const cache = await caches.open(CACHE).catch(() => undefined);
  const hit = await cache?.match(url);
  if (hit) {
    const bytes = new Uint8Array(await hit.arrayBuffer());
    onProgress(bytes.length);
    return bytes;
  }
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
  const chunks: Uint8Array[] = [];
  let n = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    n += value.length;
    onProgress(n);
  }
  const bytes = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    bytes.set(c, o);
    o += c.length;
  }
  await cache?.put(url, new Response(bytes)).catch(() => {});
  return bytes;
}

/** A little margin around a number, so a person can read it in context. */
function pad(b: Box, img: Rgba): Box {
  const m = Math.round(b.h * 0.3);
  const x = Math.max(0, b.x - m);
  const y = Math.max(0, b.y - m);
  return {
    x,
    y,
    w: Math.min(img.width, b.x + b.w + m) - x,
    h: Math.min(img.height, b.y + b.h + m) - y,
  };
}

const round = (x: number) => Math.round(x * 1000) / 1000;
