// A camera's setup from where it is and the guideway point it looks at (packages/trackside/README.md#setup),
// and speeds from image motion.
//
// The tracks in view are the track at the point tapped and the tracks running alongside it (within
// MAX_TRACK_SPREAD_M, roughly parallel), nearest the camera first: 1 to MAX_TRACKS of them. The
// camera faces from its position to the point in view, so screen-right is that bearing plus 90°:
// a train moving right travels along the track in whichever direction is closer to it.

import {
  bearingDeg,
  cumulativeLengths,
  distM,
  pointAlong,
  projectOnto,
  type LonLat,
} from "@transitopia/transit-core/geo.ts";
import { MAX_TRACKS, type CameraSetup, type TrackInView } from "./types.ts";

/**
 * Horizontal field of view of a phone's main camera filming 16:9 video at 1× (iPhone 16: 26 mm
 * equivalent, cropped to 16:9). guess
 */
export const DEFAULT_HFOV_DEG = 65;

/** The point tapped must be this close to a track. */
const MAX_SNAP_M = 30;
/** Tracks in view run within this angle of the one tapped, and at most this far from the point tapped. */
const PARALLEL_DEG = 25;
const MAX_TRACK_SPREAD_M = 20;
/** Stations considered for "toward …" labels. */
const STATION_RANGE_M = 6000;

export interface TrackSegment {
  id: string;
  kind: string;
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
      kind: typeof p.kind === "string" ? p.kind : "main",
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
  const snaps = opts.segments
    .map((s) => snap(s, target))
    .filter((s) => s.offset <= MAX_TRACK_SPREAD_M)
    .sort((a, b) => a.offset - b.offset);
  const tapped = snaps[0];
  if (!tapped || tapped.offset > MAX_SNAP_M)
    return { error: "No SkyTrain guideway there: tap on the track in view." };
  const inView = snaps
    .filter(
      (s) =>
        Math.min(
          angle(s.bearing, tapped.bearing),
          angle(s.bearing, tapped.bearing + 180),
        ) <= PARALLEL_DEG,
    )
    .map((s) => ({ ...s, fromCamera: distM(at, snap(s.segment, at).point) }))
    .sort((a, b) => a.fromCamera - b.fromCamera);
  if (inView.length > MAX_TRACKS)
    return {
      error: `${inView.length} tracks in view: up to ${MAX_TRACKS} are supported. Film somewhere with fewer tracks side by side.`,
    };
  const nearTrack = inView[0]!;
  const distance = nearTrack.fromCamera;
  if (distance < 5)
    return {
      error:
        "The camera is on the guideway: set where the camera is, beside it.",
    };
  const tracks: TrackInView[] = inView.map((s) => ({
    segment: s.segment.id,
    distanceM: Math.round(s.fromCamera * 10) / 10,
    kind: s.segment.kind,
    lines: s.segment.lines,
  }));
  const facing = bearingDeg(at, nearTrack.point);
  const right = (facing + 90) % 360;
  const rightwardBearing =
    angle(nearTrack.bearing, right) <= 90 ?
      nearTrack.bearing
    : (nearTrack.bearing + 180) % 360;
  const lines = [...new Set(inView.flatMap((s) => s.segment.lines))].sort();
  const onLines = opts.stations.filter((s) =>
    s.lines.some((l) => lines.includes(l)),
  );
  return {
    id: opts.id,
    at,
    accuracyM: opts.accuracyM,
    lines,
    tracks,
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
