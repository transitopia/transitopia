// What a trackside camera reports for each passing train (packages/trackside/README.md#reports). The
// device sends only this: no video or frames, apart from small crops of the car numbers it read.

export type LonLat = [number, number];

/** The guideway's tracks as the camera sees them: the near one is in front of the far one. */
export type TrackSide = "near" | "far";

/** Where a camera is and what it looks at, fixed when the session starts. */
export interface CameraSetup {
  /** Random per setup, so passes from one session group together. */
  id: string;
  /** The camera's position, and how sure the phone was of it. */
  at: LonLat;
  accuracyM?: number | undefined;
  /** Lines on the tracks in view, e.g. ["expo"]. */
  lines: string[];
  /** Track segment ids (tracks.geojson) of the near and far track at the point in view. */
  nearSegment: string;
  farSegment?: string | undefined;
  /** Distance from the camera to each track, in metres. */
  nearDistanceM: number;
  farDistanceM?: number | undefined;
  /** Compass bearing of a train moving left to right across the screen (0 = north). */
  rightwardBearing: number;
  /** The next stations each way, for people reading the reports. */
  towardRight?: string | undefined;
  towardLeft?: string | undefined;
  /** Horizontal field of view of the video, in degrees, and its width in pixels (for speeds). */
  hfovDeg: number;
  frameWidth: number;
}

export interface CarReading {
  /** As painted, e.g. "097". */
  number: string;
  /** Best mean digit probability among its readings, 0–1. */
  confidence: number;
  /** How many times it was read (cars carry their number at both ends). */
  reads: number;
  /** A small JPEG of the number (data: URL), kept to improve the reader. */
  crop?: string | undefined;
}

export interface PassReport {
  /** Random, made by the device, so a retried upload isn't stored twice. */
  id: string;
  setup: CameraSetup;
  /** When the train started and stopped moving through the view (ISO 8601). */
  start: string;
  end: string;
  track: TrackSide;
  /** Which way it moved on screen, and the compass bearing that means. */
  screen: "left" | "right";
  bearing: number;
  /** "Toward <station>" for people. */
  toward?: string | undefined;
  /** Speed estimated from the camera's geometry (approximate), and the raw image speed. */
  speedKmh: number | null;
  pxPerS: number;
  /** The near train hid part of this (far-track) pass. */
  occluded: boolean;
  /** Car numbers read, front of the train first. */
  cars: CarReading[];
  /** Other number-like text the reader wasn't sure of, with crops, to be checked by a person. */
  uncertain?: CarReading[] | undefined;
  /** Live camera, or a recorded clip replayed (tests: never uploaded). */
  source: "camera" | "file";
}
