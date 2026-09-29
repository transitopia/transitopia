// AIS fixes: parsing aisstream.io messages, the compact wire format of GET /rt/ais/fixes, and
// which fixes belong to a service date. Shared by the RT service and the browser (PLAN.md §4.12).

import type { RtVehicle } from "../rt/types.ts";
import { serviceDayStart } from "../time.ts";
import type { AisFix } from "./match.ts";

const KN = 1852 / 3600;
/** AIS "not available" values. */
const SOG_NA = 102.3;
const COG_NA = 360;

/** A fix from an aisstream.io PositionReport message for one of `mmsis`, else undefined. */
export function parseAisMessage(
  msg: unknown,
  mmsis: Set<string>,
): AisFix | undefined {
  const m = msg as {
    MessageType?: string;
    MetaData?: {
      MMSI?: number | string;
      ShipName?: string;
      latitude?: number;
      longitude?: number;
      time_utc?: string;
    };
    Message?: {
      PositionReport?: {
        Sog?: number;
        Cog?: number;
        Latitude?: number;
        Longitude?: number;
        Valid?: boolean;
      };
    };
  };
  if (m.MessageType !== "PositionReport" || !m.MetaData) return undefined;
  const mmsi = String(m.MetaData.MMSI ?? "");
  if (!mmsis.has(mmsi)) return undefined;
  const pr = m.Message?.PositionReport;
  if (pr?.Valid === false) return undefined;
  const lat = pr?.Latitude ?? m.MetaData.latitude;
  const lon = pr?.Longitude ?? m.MetaData.longitude;
  if (
    typeof lat !== "number"
    || typeof lon !== "number"
    || Math.abs(lat) > 90
    || Math.abs(lon) > 180
  )
    return undefined;
  const ts = parseAisTime(m.MetaData.time_utc);
  if (ts === undefined) return undefined;
  const fix: AisFix = { mmsi, ts, lat, lon };
  const name = m.MetaData.ShipName?.trim();
  if (name) fix.name = name;
  if (typeof pr?.Sog === "number" && pr.Sog < SOG_NA) fix.sog = pr.Sog;
  if (typeof pr?.Cog === "number" && pr.Cog < COG_NA) fix.cog = pr.Cog;
  return fix;
}

/** "2026-09-29 02:09:16.130641461 +0000 UTC" → epoch ms. */
export function parseAisTime(s: string | undefined): number | undefined {
  const m =
    s && /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d+)? \+0000/.exec(s);
  if (!m) return undefined;
  const ms = Date.parse(`${m[1]}T${m[2]}${m[3] ? m[3].slice(0, 4) : ""}Z`);
  return Number.isFinite(ms) ? ms : undefined;
}

/** Fixes that can belong to a service date's trips: 03:00 that day to 03:00 the next (local). */
export function serviceDateWindow(serviceDate: string): [number, number] {
  const start = serviceDayStart(serviceDate);
  return [start + 3 * 3_600_000, start + 27 * 3_600_000];
}

/** Recorded as RT vehicles (one snapshot per batch), so the RT recorder and its files can be reused. */
export function fixToVehicle(f: AisFix, routeKey: string): RtVehicle {
  const v: RtVehicle = {
    id: f.mmsi,
    routeKey,
    lat: f.lat,
    lon: f.lon,
    ts: f.ts,
  };
  if (f.name) v.label = f.name;
  if (f.cog !== undefined) v.bearing = f.cog;
  if (f.sog !== undefined) v.speed = Math.round(f.sog * KN * 100) / 100;
  return v;
}

export function vehicleToFix(v: RtVehicle): AisFix {
  const f: AisFix = { mmsi: v.id, ts: v.ts, lat: v.lat, lon: v.lon };
  if (v.label) f.name = v.label;
  if (v.bearing !== undefined) f.cog = v.bearing;
  if (v.speed !== undefined) f.sog = Math.round((v.speed / KN) * 10) / 10;
  return f;
}

/** Response of GET /rt/ais/fixes. */
export interface AisFixesResponse {
  /** Whether the upstream stream is connected now. */
  connected: boolean;
  /** Seconds since the last message from upstream (any vessel), if any. */
  lastMessageAgeS: number | null;
  error?: string;
  /** Pass as `after` (with the same epoch) to get only fixes received since this response. */
  cursor: number;
  /** Changes when the RT service restarts; a client with a cursor from another epoch refetches. */
  epoch: number;
  /** [mmsi, name, ts, lat, lon, sog, cog], sorted by ts. */
  fixes: [
    string,
    string | null,
    number,
    number,
    number,
    number | null,
    number | null,
  ][];
}

export function encodeFixes(fixes: AisFix[]): AisFixesResponse["fixes"] {
  return fixes.map((f) => [
    f.mmsi,
    f.name ?? null,
    f.ts,
    Math.round(f.lat * 1e5) / 1e5,
    Math.round(f.lon * 1e5) / 1e5,
    f.sog ?? null,
    f.cog ?? null,
  ]);
}

export function decodeFixes(rows: AisFixesResponse["fixes"]): AisFix[] {
  return rows.map(([mmsi, name, ts, lat, lon, sog, cog]) => {
    const f: AisFix = { mmsi, ts, lat, lon };
    if (name !== null) f.name = name;
    if (sog !== null) f.sog = sog;
    if (cog !== null) f.cog = cog;
    return f;
  });
}
