// Replay a recorded clip through the trackside camera detector (packages/trackside/README.md): the passes it
// finds (track, direction, speed in pixels) and, with --ocr, the car numbers read. Panoramas are
// written to var/trackside/replay/ for inspection.
//
//   npx tsx pipelines/trackside-replay.ts <video> --roi x,y,w,h --split 0.4 [--fps 30] [--from s] [--to s] [--ocr]
//
// --roi is the guideway in the video's pixels; --split the near/far line as a fraction of the ROI
// height (from its top). Needs ffmpeg. --ocr needs onnxruntime-node, which isn't a dependency (it's
// ~300 MB): `npm i --no-save onnxruntime-node`. The models are cached in var/trackside/models/.

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import {
  PassDetector,
  type DetectedPass,
} from "@transitopia/trackside/detector.ts";
import { Ocr, type OnnxModel } from "@transitopia/trackside/ocr.ts";
import { pairs } from "@transitopia/trackside/cars.ts";
import {
  MODEL_URLS,
  OCR_OPTIONS,
  parseKeys,
  readPass,
} from "@transitopia/trackside/read.ts";
import { TRACKSIDE_DIR } from "./lib/paths.ts";
import { encodePng } from "./lib/png.ts";

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    roi: { type: "string" },
    split: { type: "string", default: "0.4" },
    fps: { type: "string", default: "30" },
    from: { type: "string", default: "0" },
    to: { type: "string" },
    ocr: { type: "boolean", default: false },
  },
});
const video = positionals[0];
if (!video || !opts.roi) {
  console.error(
    "Usage: npx tsx pipelines/trackside-replay.ts <video> --roi x,y,w,h [--split 0.4] [--fps 30] [--from s] [--to s] [--ocr]",
  );
  process.exit(1);
}
const [rx, ry, rw, rh] = opts.roi.split(",").map(Number) as [
  number,
  number,
  number,
  number,
];
const fps = Number(opts.fps);
const from = Number(opts.from);
const OUT = join(TRACKSIDE_DIR, "replay");
await mkdir(OUT, { recursive: true });

const ocr = opts.ocr ? await loadOcr() : undefined;
const detector = new PassDetector({ splitY: Number(opts.split) });
const frameBytes = rw * rh * 4;

const ff = spawn(
  "ffmpeg",
  [
    "-v",
    "error",
    "-ss",
    String(from),
    ...(opts.to ? ["-t", String(Number(opts.to) - from)] : []),
    "-i",
    video,
    "-vf",
    `crop=${rw}:${rh}:${rx}:${ry},fps=${fps}`,
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgba",
    "-",
  ],
  { stdio: ["ignore", "pipe", "inherit"] },
);

let pending: Buffer = Buffer.alloc(0);
let frame = 0;
let n = 0;
const started = Date.now();
const work: Promise<void>[] = [];
for await (const chunk of ff.stdout) {
  pending =
    pending.length ?
      Buffer.concat([pending, chunk as Buffer])
    : (chunk as Buffer);
  while (pending.length >= frameBytes) {
    const data = new Uint8ClampedArray(pending.subarray(0, frameBytes));
    pending = pending.subarray(frameBytes);
    const t = from + frame++ / fps;
    for (const p of detector.push({ t, img: { width: rw, height: rh, data } }))
      work.push(report(p, ++n));
  }
}
for (const p of detector.flush()) work.push(report(p, ++n));
await Promise.all(work);
console.log(
  `${frame} frames (${(frame / fps).toFixed(0)} s of video) in ${((Date.now() - started) / 1000).toFixed(1)} s; ${n} passes. Panoramas: ${OUT}`,
);

async function report(p: DetectedPass, i: number): Promise<void> {
  const file = join(OUT, `${basename(video!)}-${i}-${p.track}.png`);
  await writeFile(
    file,
    encodePng(p.panorama.width, p.panorama.height, p.panorama.data),
  );
  let cars = "";
  if (ocr) {
    const { cars: read } = await readPass(ocr, p);
    cars = `  cars ${read.map((c) => `${c.number} (${c.confidence.toFixed(2)}×${c.reads})`).join(" ") || "none"}; pairs ${pairs(read.map((c) => c.number)).join(" ") || "–"}`;
  }
  console.log(
    `#${i} ${p.startT.toFixed(1)}–${p.endT.toFixed(1)} s  ${p.track.padEnd(4)} ${p.direction > 0 ? "→" : "←"}  ${Math.round(p.pxPerS)} px/s  ${p.travelPx} px${p.occluded ? "  (occluded)" : ""}${cars}`,
  );
}

async function loadOcr(): Promise<Ocr> {
  const ort = (await import("onnxruntime-node" as string).catch(() => {
    console.error(
      "--ocr needs onnxruntime-node: npm i --no-save onnxruntime-node",
    );
    process.exit(1);
  })) as OrtNode;
  const dir = join(TRACKSIDE_DIR, "models");
  await mkdir(dir, { recursive: true });
  const cached = async (url: string): Promise<Buffer> => {
    const file = join(dir, basename(url));
    try {
      return await readFile(file);
    } catch {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      await writeFile(file, buf);
      return buf;
    }
  };
  const model = async (url: string): Promise<OnnxModel> => {
    const s = await ort.InferenceSession.create(await cached(url));
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
  return new Ocr(
    {
      det: await model(MODEL_URLS.det),
      rec: await model(MODEL_URLS.rec),
      keys: parseKeys((await cached(MODEL_URLS.keys)).toString("utf8")),
    },
    OCR_OPTIONS,
  );
}

/** The part of onnxruntime-node's API used here (it isn't a dependency, so no types). */
interface OrtNode {
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
