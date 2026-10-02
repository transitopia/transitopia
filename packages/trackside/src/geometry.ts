// A camera's setup from where it is and the guideway point it looks at (packages/trackside/README.md#setup),
// and speeds from image motion.
//
// The camera faces from its position to the point in view, so screen-right is that bearing plus
// 90°: a train moving right travels along the track in whichever direction is closer to it. The
// near track is the one closest to the camera; the far one is the next parallel track beyond it.

import {
  bearingDeg,
  cumulativeLengths,
  distM,
  pointAlong,
  projectOnto,
  type LonLat,
} from "@transitopia/transit-core/geo.ts";
import type { CameraSetup } from "./types.ts";

/**
 * Horizontal field of view of a phone's main camera filming 16:9 video at 1× (iPhone 16: 26 mm
 * equivalent, cropped to 16:9). guess
 */
export const DEFAULT_HFOV_DEG = 65;

/** Tracks farther from the point in view than this aren't the ones in view. */
const MAX_SNAP_M = 60;
/** The far track runs within this angle of the near one and at most this far beyond it. */
const PARALLEL_DEG = 25;
const MAX_TRACK_SPACING_M = 15;
/** Stations considered for "toward …" labels. */
const STATION_RANGE_M = 6000;

export interface TrackSegment {
  id: string;
  lines: string[];
  coords: LonLat[];
  cum: Float64Array;
}

export interface Station {
  name: string;
  at: LonLat;
  lines: string[];
}

interface GeoJsonish {
  features: {
    properties: Record<string, unknown> | null;
    geometry: { type: string; coordinates: unknown } | null;
  }[];
}

/** Main-line track segments and stations from tracks.geojson (packages/transit-core/src/infra/types.ts). */
export function readTracks(fc: GeoJsonish): {
  segments: TrackSegment[];
  stations: Station[];
} {
  const segments: TrackSegment[] = [];
  const stations: Station[] = [];
  const linesOf = new Map<string, string[]>();
  for (const f of fc.features) {
    const p = f.properties ?? {};
    if (p.type !== "segment" || f.geometry?.type !== "LineString") continue;
    const lines = (p.lines as string[] | undefined) ?? [];
    linesOf.set(String(p.id), lines);
    // Tunnels can't be filmed.
    if (p.tunnel) continue;
    const coords = f.geometry.coordinates as LonLat[];
    segments.push({
      id: String(p.id),
      lines,
      coords,
      cum: cumulativeLengths(coords),
    });
  }
  for (const f of fc.features) {
    const p = f.properties ?? {};
    if (p.type === "stop" && f.geometry?.type === "Point")
      stations.push({
        name: String(p.name),
        at: f.geometry.coordinates as LonLat,
        lines: linesOf.get(String(p.segment)) ?? [],
      });
  }
  return { segments, stations };
}

interface Snap {
  segment: TrackSegment;
  /** Distance from the point snapped, in metres. */
  offset: number;
  point: LonLat;
  /** Bearing of the track there (in its digitised direction). */
  bearing: number;
}

function snap(segment: TrackSegment, p: LonLat): Snap {
  const { along, offset } = projectOnto(segment.coords, segment.cum, p, 0, 0);
  const at = pointAlong(segment.coords, segment.cum, along);
  return { segment, offset, point: [at.lon, at.lat], bearing: at.bearing };
}

const angle = (a: number, b: number) => {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return Math.min(d, 360 - d);
};

/**
 * The setup for a camera at `at` looking at `target`, or why there isn't one (no guideway near
 * the target, or the camera on top of it).
 */
export function cameraSetup(opts: {
  id: string;
  at: LonLat;
  accuracyM?: number | undefined;
  target: LonLat;
  segments: TrackSegment[];
  stations: Station[];
  hfovDeg: number;
  frameWidth: number;
}): CameraSetup | { error: string } {
  const { at, target } = opts;
  const near = opts.segments
    .map((s) => snap(s, target))
    .filter((s) => s.offset <= MAX_SNAP_M)
    .map((s) => ({ ...s, fromCamera: snap(s.segment, at).offset }))
    .sort((a, b) => a.offset - b.offset);
  if (!near.length)
    return { error: "No SkyTrain guideway there: tap on the track in view." };
  // Of the tracks at the point in view, the nearest to the camera is the near track.
  const here = near.filter(
    (s) => s.offset <= near[0]!.offset + MAX_TRACK_SPACING_M,
  );
  here.sort((a, b) => a.fromCamera - b.fromCamera);
  const nearTrack = here[0]!;
  const farTrack = here.find(
    (s) =>
      s !== nearTrack
      && s.fromCamera > nearTrack.fromCamera + 1
      && s.fromCamera <= nearTrack.fromCamera + MAX_TRACK_SPACING_M
      && Math.min(
        angle(s.bearing, nearTrack.bearing),
        angle(s.bearing, nearTrack.bearing + 180),
      ) <= PARALLEL_DEG,
  );
  const distance = distM(at, nearTrack.point);
  if (distance < 5)
    return {
      error:
        "The camera is on the guideway: set where the camera is, beside it.",
    };
  const facing = bearingDeg(at, nearTrack.point);
  const right = (facing + 90) % 360;
  const rightwardBearing =
    angle(nearTrack.bearing, right) <= 90 ?
      nearTrack.bearing
    : (nearTrack.bearing + 180) % 360;
  const lines = [...new Set(here.flatMap((s) => s.segment.lines))].sort();
  const onLines = opts.stations.filter((s) =>
    s.lines.some((l) => lines.includes(l)),
  );
  return {
    id: opts.id,
    at,
    accuracyM: opts.accuracyM,
    lines,
    nearSegment: nearTrack.segment.id,
    farSegment: farTrack?.segment.id,
    nearDistanceM: Math.round(distance * 10) / 10,
    farDistanceM:
      farTrack ? Math.round(distM(at, farTrack.point) * 10) / 10 : undefined,
    rightwardBearing: Math.round(rightwardBearing),
    towardRight: nextStation(nearTrack.point, rightwardBearing, onLines),
    towardLeft: nextStation(
      nearTrack.point,
      (rightwardBearing + 180) % 360,
      onLines,
    ),
    hfovDeg: opts.hfovDeg,
    frameWidth: opts.frameWidth,
  };
}

/** The nearest station roughly ahead along `bearing` (for labels only: lines curve). */
function nextStation(
  from: LonLat,
  bearing: number,
  stations: Station[],
): string | undefined {
  let best: { name: string; d: number } | undefined;
  for (const s of stations) {
    const d = distM(from, s.at);
    if (d < 50 || d > STATION_RANGE_M) continue;
    if (angle(bearingDeg(from, s.at), bearing) > 60) continue;
    if (!best || d < best.d) best = { name: s.name, d };
  }
  return best?.name;
}

/** Compass bearing of a train moving that way across the screen. */
export const travelBearing = (
  setup: CameraSetup,
  screen: "left" | "right",
): number =>
  screen === "right" ?
    setup.rightwardBearing
  : (setup.rightwardBearing + 180) % 360;

/**
 * Approximate speed from image speed: at distance d, a frame `frameWidth` pixels wide spans
 * 2·d·tan(hfov / 2) metres. Errors in the camera's position and field of view carry straight
 * through, so this is approximate (±20 % or so).
 */
export function speedKmh(
  pxPerS: number,
  distanceM: number,
  hfovDeg: number,
  frameWidth: number,
): number {
  const metresAcross = 2 * distanceM * Math.tan((hfovDeg * Math.PI) / 360);
  return Math.round(((pxPerS * metresAcross) / frameWidth) * 3.6);
}

/** The field of view at a digital zoom factor. */
export const zoomedHfov = (hfovDeg: number, zoom: number): number =>
  (2 * Math.atan(Math.tan((hfovDeg * Math.PI) / 360) / Math.max(1, zoom)) * 180)
  / Math.PI;
