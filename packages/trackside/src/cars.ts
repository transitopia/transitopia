// Car numbers from text readings (packages/trackside/README.md#reading-car-numbers): keep readings that look
// like car numbers, merge repeats (cars carry their number at both ends), order them front first,
// and name married-pair partners. Rules come from regions/metro-vancouver/config/trackside.json.

import config from "@transitopia/region-metro-vancouver/config/trackside.json" with { type: "json" };
import type { Box } from "./image.ts";
import type { OcrText } from "./ocr.ts";

export interface CarRules {
  pattern: RegExp;
  marriedPairs: boolean;
  minConfidence: number;
  maxHeightFraction: number;
}

export const carRules: CarRules = {
  pattern: new RegExp(config.cars.pattern),
  marriedPairs: config.cars.marriedPairs,
  minConfidence: config.cars.minConfidence,
  maxHeightFraction: config.cars.maxHeightFraction,
};

export interface CarSighting {
  number: string;
  confidence: number;
  reads: number;
  /** The best reading's box, in panorama coordinates. */
  box: Box;
}

/**
 * Car numbers in a train's panorama, front first. `frontAtRight` is true when the train moved
 * right on screen (its front is at the panorama's right end).
 */
export function carsFromTexts(
  texts: OcrText[],
  imageHeight: number,
  frontAtRight: boolean,
  rules: CarRules = carRules,
): CarSighting[] {
  const byNumber = new Map<string, CarSighting>();
  for (const t of texts) {
    if (t.box.h > rules.maxHeightFraction * imageHeight) continue;
    if (!rules.pattern.test(t.digits) || t.confidence < rules.minConfidence)
      continue;
    const seen = byNumber.get(t.digits);
    if (!seen)
      byNumber.set(t.digits, {
        number: t.digits,
        confidence: t.confidence,
        reads: 1,
        box: t.box,
      });
    else {
      seen.reads++;
      if (t.confidence > seen.confidence) {
        seen.confidence = t.confidence;
        seen.box = t.box;
      }
    }
  }
  const cars = [...byNumber.values()].sort((a, b) => a.box.x - b.box.x);
  return frontAtRight ? cars.reverse() : cars;
}

/** The other car of a married pair (odd n ↔ n + 1), or undefined. */
export function partner(
  number: string,
  rules: CarRules = carRules,
): string | undefined {
  if (!rules.marriedPairs || !rules.pattern.test(number)) return undefined;
  const n = Number(number);
  const p = n % 2 ? n + 1 : n - 1;
  return p > 0 ? String(p).padStart(number.length, "0") : undefined;
}

/** Married pairs among the numbers read, e.g. ["097·098", "101·102"], in the order first seen. */
export function pairs(numbers: string[], rules: CarRules = carRules): string[] {
  const out: string[] = [];
  const done = new Set<string>();
  for (const n of numbers) {
    if (done.has(n)) continue;
    const p = partner(n, rules);
    if (!p) {
      out.push(n);
      done.add(n);
      continue;
    }
    const [a, b] = Number(n) < Number(p) ? [n, p] : [p, n];
    out.push(`${a}·${b}`);
    done.add(a).add(b);
  }
  return out;
}

/** At most this many uncertain readings are kept per pass. */
const MAX_UNCERTAIN = 12;

/**
 * Number-like text that wasn't read confidently as a car number: kept (as crops) for a person to
 * check, which is how the reader gets better. Most confident first.
 */
export function uncertainTexts(
  texts: OcrText[],
  imageHeight: number,
  rules: CarRules = carRules,
): OcrText[] {
  return texts
    .filter(
      (t) =>
        t.box.h <= rules.maxHeightFraction * imageHeight
        && t.digits.length >= 2
        && !(
          rules.pattern.test(t.digits) && t.confidence >= rules.minConfidence
        ),
    )
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, MAX_UNCERTAIN);
}
