// The live endpoint, GET /regions/<id>/live/transit (apps/server/README.md#live-endpoint): one response
// for every visitor, so Cloudflare's edge can share it, with a section per live source. Shared by
// the server and the browser.
//
// Small data that changes often travels inline, in the compact formats history uses (vehicles as
// in /rt/history lines, AIS fixes as encodeFixes rows). Larger or rarely changing data is a pointer
// per service date to an immutable file (service changes, dispatch patches), fetched only when its
// version changes. Sections have a `kind` so readers pick the ones they understand: a second
// agency's vehicles would be a second "vehicles" section under its own source id.
//
// The body only changes when the data does (no request time or ages in it), so its ETag lets an
// unchanged poll be a 304.

import type { AisRow } from "../ais/fixes.ts";
import type { CompactSnapshot } from "./types.ts";

export const LIVE_SCHEMA = 1;

/** ok: current; stale: the latest data is older than its source's schedule allows; unavailable: none. */
export type LiveStatus = "ok" | "stale" | "unavailable";

interface DataSection {
  status: LiveStatus;
  /** Why data is stale or unavailable, for display. */
  error?: string;
}

/** The latest positions poll of a GTFS-RT feed (routes we draw only). */
export interface LiveVehiclesSection extends DataSection {
  kind: "vehicles";
  encoding: "rt-snapshot/1";
  data: CompactSnapshot | null;
}

/**
 * AIS fixes recorded in batches (packages/transit-core/DESIGN.md#seabus-ais) from `from` (exclusive) to `to`
 * (inclusive), by batch time. Everything recorded up to `to` is in these and the day files
 * (GET /regions/<id>/days/<YYYYMMDD>/seabus/ais), so a reader whose day file reaches `from` has no gap.
 */
export interface LiveAisSection extends DataSection {
  kind: "ais";
  encoding: "ais-fixes/1";
  /** The route key the fixes correct. */
  route: string;
  from: number;
  to: number;
  data: AisRow[];
}

/** A version of a per-date file, and where to fetch it (relative to the API base; immutable). */
export interface VersionPointer {
  version: string;
  path: string;
}

/** The current version per service date (YYYYMMDD). */
interface PointerSection<K extends string> {
  kind: K;
  versions: Record<string, VersionPointer>;
}

/** Bus service changes (packages/transit-core/src/rt/changes.ts). */
export type LiveChangesSection = PointerSection<"changes">;
/** Live dispatch patches (packages/transit-core/DESIGN.md#dispatcher). */
export type LiveDispatchSection = PointerSection<"dispatch">;

export type LiveSection =
  | LiveVehiclesSection
  | LiveAisSection
  | LiveChangesSection
  | LiveDispatchSection;

export interface LiveTransitResponse {
  schema: typeof LIVE_SCHEMA;
  /** Epoch ms when the server next expects new data (a poll or an AIS batch), or null if it doesn't know. */
  nextAt: number | null;
  /** By source id, e.g. "translink/vehicles", "seabus/ais", "translink/changes", "dispatch". */
  sources: Record<string, LiveSection>;
}

/** The sections of one kind, in source id order. */
export function sectionsOfKind<K extends LiveSection["kind"]>(
  r: LiveTransitResponse,
  kind: K,
): Extract<LiveSection, { kind: K }>[] {
  return Object.keys(r.sources)
    .sort()
    .map((id) => r.sources[id]!)
    .filter((s): s is Extract<LiveSection, { kind: K }> => s.kind === kind);
}
