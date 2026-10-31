// A learned bus profile as published: one file per time-of-day band, rt-profile.<band>.bin in each
// feed version's directory (packages/transit-core/DESIGN.md#buses). A band's file holds every
// shape's pace and dwells in that band, with the all-day profile's filled in where the band has
// none, so a client loads only the bands it shows and needs no fallback of its own.
//
// Format: the header's length (u32, little-endian), the header (JSON, BandFileHeader), then per
// shape in the header's order one byte per bin of pace and one byte per listed stop of dwell.
//  - Pace: 0 where unknown, else 1 + round(ln(pace / PACE_MIN) / ln(PACE_STEP)), clamped to 1–255:
//    3% steps, from 0.02 s/m (50 m/s) to ~37 s/m. Each byte is stored as its difference from the
//    one before (mod 256), which brotli compresses better: neighbouring bins have similar paces.
//  - Dwell: whole seconds, capped at 255.

import type { RtProfile } from "./profile.ts";

export interface ShapeBand {
  /** s/m per bin; NaN where unknown. */
  pace: Float32Array;
  /** The stops with an expected dwell, and their dwells (s) in the same order. */
  stops: readonly string[];
  dwell: Float32Array;
}

export interface RtBandProfile {
  feedVersion: string;
  builtAt: string;
  binM: number;
  bandStartHours: number[];
  band: number;
  shapes: Map<string, ShapeBand>;
}

interface BandFileHeader {
  format: 1;
  feedVersion: string;
  builtAt: string;
  binM: number;
  bandStartHours: number[];
  band: number;
  /** Per shape: its id, its bins, and the ids of its stops with a dwell. */
  shapes: [string, number, string[]][];
}

const PACE_MIN = 0.02;
const PACE_STEP = 1.03;
const MAX_DWELL_S = 255;
const PACE_OF_CODE = Float32Array.from({ length: 256 }, (_, c) =>
  c === 0 ? NaN : PACE_MIN * PACE_STEP ** (c - 1),
);

/** The published file of a band. */
export const bandFileName = (band: number) => `rt-profile.${band}.bin`;

/** One band of a profile, with the all-day profile filled in where the band has no data. */
export function bandProfile(profile: RtProfile, band: number): RtBandProfile {
  const shapes = new Map<string, ShapeBand>();
  for (const [id, s] of Object.entries(profile.shapes)) {
    const bp = s.bands[band] ?? null;
    const pace = Float32Array.from(
      s.all.pace,
      (p, b) => bp?.pace[b] ?? p ?? NaN,
    );
    const dwells = { ...s.all.dwell, ...bp?.dwell };
    const stops = Object.keys(dwells);
    shapes.set(id, {
      pace,
      stops,
      dwell: Float32Array.from(stops, (k) => dwells[k]!),
    });
  }
  return {
    feedVersion: profile.feedVersion,
    builtAt: profile.builtAt,
    binM: profile.binM,
    bandStartHours: profile.bandStartHours,
    band,
    shapes,
  };
}

/** Every band of a profile (bandProfile). */
export const bandProfiles = (profile: RtProfile): RtBandProfile[] =>
  profile.bandStartHours.map((_, b) => bandProfile(profile, b));

/** Every band of a profile as clients read it: through the file's encoding. */
export const publishedBandProfiles = (profile: RtProfile): RtBandProfile[] =>
  bandProfiles(profile).map((b) => decodeBandProfile(encodeBandProfile(b)));

export function encodeBandProfile(p: RtBandProfile): Uint8Array {
  const header: BandFileHeader = {
    format: 1,
    feedVersion: p.feedVersion,
    builtAt: p.builtAt,
    binM: p.binM,
    bandStartHours: p.bandStartHours,
    band: p.band,
    shapes: [...p.shapes].map(([id, s]) => [id, s.pace.length, [...s.stops]]),
  };
  const json = new TextEncoder().encode(JSON.stringify(header));
  let size = 4 + json.length;
  for (const s of p.shapes.values()) size += s.pace.length + s.stops.length;
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, json.length, true);
  out.set(json, 4);
  let o = 4 + json.length;
  for (const s of p.shapes.values()) {
    let prev = 0;
    for (const pace of s.pace) {
      const code =
        Number.isNaN(pace) ? 0 : (
          Math.min(
            255,
            Math.max(
              1,
              1 + Math.round(Math.log(pace / PACE_MIN) / Math.log(PACE_STEP)),
            ),
          )
        );
      out[o++] = (code - prev) & 255;
      prev = code;
    }
    for (const d of s.dwell) out[o++] = Math.min(MAX_DWELL_S, Math.round(d));
  }
  return out;
}

export function decodeBandProfile(bytes: Uint8Array): RtBandProfile {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(0, true);
  const header = JSON.parse(
    new TextDecoder().decode(bytes.subarray(4, 4 + length)),
  ) as BandFileHeader;
  if (header.format !== 1)
    throw new Error(`Unknown profile format ${String(header.format)}`);
  let o = 4 + length;
  const shapes = new Map<string, ShapeBand>();
  for (const [id, bins, stops] of header.shapes) {
    const pace = new Float32Array(bins);
    let code = 0;
    for (let b = 0; b < bins; b++) {
      code = (code + bytes[o++]!) & 255;
      pace[b] = PACE_OF_CODE[code]!;
    }
    const dwell = Float32Array.from(bytes.subarray(o, o + stops.length));
    o += stops.length;
    shapes.set(id, { pace, stops, dwell });
  }
  if (o !== bytes.length) throw new Error("Malformed profile file");
  return {
    feedVersion: header.feedVersion,
    builtAt: header.builtAt,
    binM: header.binM,
    bandStartHours: header.bandStartHours,
    band: header.band,
    shapes,
  };
}
