// Car numbers from text readings (packages/trackside/README.md#reading-car-numbers): keep readings that look
// like car numbers, merge repeats (cars carry their number at both ends), order them front first,
// and group them into the sets of cars that always run together (Mk I and Mk II married pairs, Mk
// III 4-car sets). Rules come from regions/metro-vancouver/config/trackside.json (OPEN-QUESTIONS #32).

import config from "@transitopia/region-metro-vancouver/config/trackside.json" with { type: "json" };
import type { Box } from "./image.ts";
import type { OcrText } from "./ocr.ts";

export interface Fleet {
  type: string;
  from: number;
  to: number;
  digits: number;
  /** Consecutively numbered cars that always run together, if they follow that rule. */
  setSize?: number | undefined;
}

export interface CarRules {
  pattern: RegExp;
  minConfidence: number;
  maxHeightFraction: number;
  fleets: Fleet[];
}

export const carRules: CarRules = {
  pattern: new RegExp(config.cars.pattern),
  minConfidence: config.cars.minConfidence,
  maxHeightFraction: config.cars.maxHeightFraction,
  fleets: config.fleets.list,
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
    if (!isCar(t, imageHeight, rules)) continue;
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

/** A confident reading of a number in a known fleet, in a box no taller than a number's. */
function isCar(t: OcrText, imageHeight: number, rules: CarRules): boolean {
  return (
    t.box.h <= rules.maxHeightFraction * imageHeight
    && rules.pattern.test(t.digits)
    && t.confidence >= rules.minConfidence
    && fleetOf(t.digits, rules) !== undefined
  );
}

/** The fleet a car number belongs to, if it's a known one. */
export function fleetOf(
  number: string,
  rules: CarRules = carRules,
): Fleet | undefined {
  const n = Number(number);
  return rules.fleets.find(
    (f) => number.length === f.digits && n >= f.from && n <= f.to,
  );
}

/** Every car of the set a car belongs to (e.g. 097 → 097, 098; 443 → 441–444), or just itself. */
export function setOf(number: string, rules: CarRules = carRules): string[] {
  const k = fleetOf(number, rules)?.setSize;
  if (!k) return [number];
  const first = Math.floor((Number(number) - 1) / k) * k + 1;
  return Array.from({ length: k }, (_, i) =>
    String(first + i).padStart(number.length, "0"),
  );
}

/**
 * The numbers read, grouped by set in the order first seen, for people: "097·098" (a pair),
 * "441–444" (a 4-car set); numbers outside known sets stay on their own.
 */
export function trainsets(
  numbers: string[],
  rules: CarRules = carRules,
): string[] {
  const out: string[] = [];
  const done = new Set<string>();
  for (const n of numbers) {
    if (done.has(n)) continue;
    const set = setOf(n, rules);
    for (const c of set) done.add(c);
    out.push(
      set.length === 1 ? n
      : set.length === 2 ? set.join("·")
      : `${set[0]}–${set.at(-1)}`,
    );
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
        && !isCar(t, imageHeight, rules),
    )
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, MAX_UNCERTAIN);
}
