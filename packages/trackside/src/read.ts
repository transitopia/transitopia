// Reading a detected pass (packages/trackside/README.md#reading-car-numbers): the text in its panorama
// becomes car numbers, front first. The models are PaddleOCR's PP-OCRv4 (mobile) detector and
// recogniser in ONNX form, fetched at runtime from the npm package @gutenye/ocr-models on jsDelivr,
// so they ship with neither the site nor the repo.

import { carsFromTexts, type CarSighting } from "./cars.ts";
import type { DetectedPass } from "./detector.ts";
import type { Ocr, OcrText } from "./ocr.ts";

const MODELS = "https://cdn.jsdelivr.net/npm/@gutenye/ocr-models@1.4.2/assets/";
export const MODEL_URLS = {
  det: `${MODELS}ch_PP-OCRv4_det_infer.onnx`,
  rec: `${MODELS}ch_PP-OCRv4_rec_infer.onnx`,
  keys: `${MODELS}ppocr_keys_v1.txt`,
};

/** onnxruntime-web, loaded by the page from the same CDN (its wasm is too large to bundle). */
export const ORT_WEB =
  "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/";

/** Detection at twice the size finds the small numbers on Mk I cars (~20 px tall at 1080p). */
export const OCR_OPTIONS = { detScale: 2, tileWidth: 480, tileOverlap: 120 };

/** Car numbers in a pass's panorama, front first, plus every text read (for debugging). */
export async function readPass(
  ocr: Ocr,
  pass: DetectedPass,
): Promise<{ cars: CarSighting[]; texts: OcrText[] }> {
  const texts = await ocr.read(pass.panorama);
  return {
    cars: carsFromTexts(texts, pass.panorama.height, pass.direction > 0),
    texts,
  };
}

/** The dictionary file's characters, one per line. */
export function parseKeys(text: string): string[] {
  const lines = text.replace(/\r/g, "").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}
