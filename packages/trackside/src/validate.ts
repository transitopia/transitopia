// What the server accepts from a trackside camera (packages/trackside/README.md#reports).

import type { CarReading, PassReport } from "./types.ts";

/** Crops are small JPEGs of a number; anything bigger isn't one. */
export const MAX_CROP_BYTES = 40_000;
export const MAX_CROPS = 40;
const ID = /^[a-z0-9][a-z0-9-]{7,63}$/i;

export function passProblems(r: PassReport): string[] {
  const p: string[] = [];
  if (!r || typeof r !== "object") return ["not a pass report"];
  if (typeof r.id !== "string" || !ID.test(r.id))
    p.push("id must be 8–64 of [a-z0-9-]");
  if (r.source !== "camera") p.push("only live camera passes are stored");
  if (r.track !== "near" && r.track !== "far")
    p.push("track must be near or far");
  if (r.screen !== "left" && r.screen !== "right")
    p.push("screen must be left or right");
  if (!isBearing(r.bearing)) p.push("bearing must be 0–360");
  const start = instant(r.start);
  const end = instant(r.end);
  if (start === undefined || end === undefined || end < start)
    p.push("start and end must be ISO 8601 times with offset, start first");
  if (
    r.speedKmh !== null
    && !(typeof r.speedKmh === "number" && r.speedKmh >= 0 && r.speedKmh < 300)
  )
    p.push("speedKmh must be null or 0–300");
  const s = r.setup;
  if (!s || typeof s !== "object" || typeof s.id !== "string" || !ID.test(s.id))
    p.push("setup.id must be 8–64 of [a-z0-9-]");
  else {
    if (!isLonLat(s.at)) p.push("setup.at must be [lon, lat]");
    if (typeof s.nearSegment !== "string")
      p.push("setup.nearSegment is required");
    if (!Array.isArray(s.lines)) p.push("setup.lines must be a list");
  }
  const readings = [
    ...(Array.isArray(r.cars) ? r.cars : []),
    ...(Array.isArray(r.uncertain) ? r.uncertain : []),
  ];
  if (!Array.isArray(r.cars)) p.push("cars must be a list");
  if (readings.length > MAX_CROPS) p.push(`at most ${MAX_CROPS} readings`);
  for (const c of readings) p.push(...readingProblems(c));
  return p;
}

function readingProblems(c: CarReading): string[] {
  if (!c || typeof c.number !== "string" || c.number.length > 12)
    return ["each reading needs a number (≤ 12 characters)"];
  if (!(c.confidence >= 0 && c.confidence <= 1))
    return [`${c.number}: confidence must be 0–1`];
  if (c.crop !== undefined && !jpegBytes(c.crop))
    return [
      `${c.number}: crop must be a JPEG data: URL under ${MAX_CROP_BYTES} bytes`,
    ];
  return [];
}

/** The bytes of a JPEG data: URL, or undefined if it isn't one (or is too big). */
export function jpegBytes(dataUrl: string): Uint8Array | undefined {
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m || m[1]!.length > (MAX_CROP_BYTES * 4) / 3 + 4) return undefined;
  const bytes = Uint8Array.from(atob(m[1]!), (ch) => ch.charCodeAt(0));
  return bytes[0] === 0xff && bytes[1] === 0xd8 ? bytes : undefined;
}

const isBearing = (b: unknown) => typeof b === "number" && b >= 0 && b <= 360;

const isLonLat = (v: unknown) =>
  Array.isArray(v)
  && v.length === 2
  && typeof v[0] === "number"
  && typeof v[1] === "number"
  && Math.abs(v[0]) <= 180
  && Math.abs(v[1]) <= 90;

/** Epoch ms of an ISO 8601 time with an offset (or Z), else undefined. */
function instant(iso: unknown): number | undefined {
  if (
    typeof iso !== "string"
    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:\d\d)$/.test(iso)
  )
    return undefined;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : undefined;
}
