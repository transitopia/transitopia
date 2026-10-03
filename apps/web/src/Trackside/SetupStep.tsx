// /trackside setup (packages/trackside/README.md#setup): where the camera is (GPS, or tapped) and the guideway
// point it looks at (tapped), on the site's map with the SkyTrain tracks drawn. From those the
// setup knows the near and far track, which screen direction is which way, and the distances.

import React from "react";
import type { GeoJSONSource, MapMouseEvent } from "maplibre-gl";
import type { LonLat } from "@transitopia/transit-core/geo.ts";
import {
  cameraSetup,
  DEFAULT_HFOV_DEG,
  readTracks,
  type Station,
  type TrackSegment,
} from "@transitopia/trackside/geometry.ts";
import { trackNames, type CameraSetup } from "@transitopia/trackside/types.ts";
import { AsyncMapLibreGLLoader, Map } from "../Map/Map.tsx";
import { useMap, useStyleGeneration } from "../Map/MapUtils.ts";
import { transitData } from "../config.ts";

const PLACE_KEY = "transitopia:trackside-place";
const button =
  "rounded border border-gray-300 px-3 py-2 text-sm hover:bg-gray-100 disabled:opacity-50 dark:border-gray-600 dark:hover:bg-gray-800";
const primary =
  "rounded bg-blue-700 px-3 py-2 text-sm text-white hover:bg-blue-800 disabled:opacity-50";

export interface SetupResult {
  setup: CameraSetup;
  file?: File | undefined;
}

export function SetupStep({ onDone }: { onDone: (r: SetupResult) => void }) {
  return (
    <AsyncMapLibreGLLoader
      loadingContent={
        <div className="p-6 text-gray-500">Loading the map…</div>
      }>
      <Map>
        <SetupOverlay onDone={onDone} />
      </Map>
    </AsyncMapLibreGLLoader>
  );
}

interface Place {
  /** Set by tapping; otherwise the GPS position is used. */
  camera?: LonLat | undefined;
  target?: LonLat | undefined;
}

function loadPlace(): Place {
  try {
    return (
      (JSON.parse(localStorage.getItem(PLACE_KEY) ?? "null") as Place | null)
      ?? {}
    );
  } catch {
    return {};
  }
}

function SetupOverlay({ onDone }: { onDone: (r: SetupResult) => void }) {
  const map = useMap();
  const styleGeneration = useStyleGeneration();
  const [tracks, setTracks] = React.useState<{
    fc: GeoJSON.FeatureCollection;
    segments: TrackSegment[];
    stations: Station[];
  }>();
  const [tracksError, setTracksError] = React.useState<string>();
  const [gps, setGps] = React.useState<{ at: LonLat; accuracy: number }>();
  const [gpsError, setGpsError] = React.useState<string>();
  const [place, setPlace] = React.useState<Place>(loadPlace);
  const [tapSets, setTapSets] = React.useState<"target" | "camera">("target");
  const fileInput = React.useRef<HTMLInputElement>(null);
  const centred = React.useRef(false);

  React.useEffect(() => {
    fetch(`${transitData}data/infra/tracks.geojson`)
      .then((r) =>
        r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)),
      )
      .then((fc: GeoJSON.FeatureCollection) =>
        setTracks({
          fc,
          ...readTracks(fc as Parameters<typeof readTracks>[0]),
        }),
      )
      .catch((e: Error) =>
        setTracksError(`Couldn't load the track network: ${e.message}`),
      );
  }, []);

  React.useEffect(() => {
    if (!navigator.geolocation)
      return setGpsError("This browser has no location.");
    const id = navigator.geolocation.watchPosition(
      (p) => {
        setGps({
          at: [p.coords.longitude, p.coords.latitude],
          accuracy: p.coords.accuracy,
        });
        setGpsError(undefined);
      },
      (e) => setGpsError(e.message || "Location unavailable"),
      { enableHighAccuracy: true, maximumAge: 5000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, []);

  const camera = place.camera ?? gps?.at;
  const result = React.useMemo(() => {
    if (!tracks || !camera || !place.target) return undefined;
    return cameraSetup({
      // A fresh id is given when the camera starts (start()).
      id: "pending",
      at: camera,
      accuracyM: place.camera ? undefined : gps?.accuracy,
      target: place.target,
      segments: tracks.segments,
      stations: tracks.stations,
      hfovDeg: DEFAULT_HFOV_DEG,
      frameWidth: 1920,
    });
  }, [tracks, camera, place.target, place.camera, gps?.accuracy]);
  const setup = result && !("error" in result) ? result : undefined;
  const start = (file?: File) =>
    setup && onDone({ setup: { ...setup, id: crypto.randomUUID() }, file });

  // Centre on the camera (or the remembered target) once.
  React.useEffect(() => {
    const at = place.target ?? camera;
    if (!map || !at || centred.current) return;
    centred.current = true;
    map.jumpTo({ center: at, zoom: Math.max(map.getZoom(), 17) });
  }, [map, camera, place.target]);

  React.useEffect(() => {
    try {
      localStorage.setItem(PLACE_KEY, JSON.stringify(place));
    } catch {
      // Remembering the place is a convenience.
    }
  }, [place]);

  // Taps set the target (or the camera position).
  React.useEffect(() => {
    if (!map) return;
    const onClick = (e: MapMouseEvent) => {
      const at: LonLat = [e.lngLat.lng, e.lngLat.lat];
      setPlace((p) =>
        tapSets === "camera" ? { ...p, camera: at } : { ...p, target: at },
      );
      if (tapSets === "camera") setTapSets("target");
    };
    map.on("click", onClick);
    return () => void map.off("click", onClick);
  }, [map, tapSets]);

  // Layers: the tracks, the tracks in view, and the camera's sight line. Re-added after a theme switch.
  React.useEffect(() => {
    if (!map || !tracks) return;
    if (!map.getSource("trackside-tracks")) {
      map.addSource("trackside-tracks", { type: "geojson", data: tracks.fc });
      map.addLayer({
        id: "trackside-tracks",
        type: "line",
        source: "trackside-tracks",
        filter: ["==", ["get", "type"], "segment"],
        paint: { "line-color": "#64748b", "line-width": 2 },
      });
    }
    if (!map.getSource("trackside-setup")) {
      map.addSource("trackside-setup", { type: "geojson", data: emptyFc() });
      map.addLayer({
        id: "trackside-in-view",
        type: "line",
        source: "trackside-setup",
        filter: ["has", "track"],
        paint: {
          // Track colours as on the camera view (CameraStep.tsx COLORS), nearest first.
          "line-color": [
            "match",
            ["get", "track"],
            0,
            "#16a34a",
            1,
            "#d97706",
            "#7c3aed",
          ],
          "line-width": 5,
        },
      });
      map.addLayer({
        id: "trackside-sight",
        type: "line",
        source: "trackside-setup",
        filter: ["==", ["get", "kind"], "sight"],
        paint: {
          "line-color": "#2563eb",
          "line-width": 2,
          "line-dasharray": [2, 2],
        },
      });
      map.addLayer({
        id: "trackside-points",
        type: "circle",
        source: "trackside-setup",
        filter: ["==", ["geometry-type"], "Point"],
        paint: {
          "circle-radius": 7,
          "circle-color": [
            "match",
            ["get", "kind"],
            "camera",
            "#2563eb",
            "#dc2626",
          ],
          "circle-stroke-color": "#fff",
          "circle-stroke-width": 2,
        },
      });
    }
  }, [map, tracks, styleGeneration]);

  React.useEffect(() => {
    const source = map?.getSource("trackside-setup") as
      GeoJSONSource | undefined;
    if (!source || !tracks) return;
    const features: GeoJSON.Feature[] = [];
    if (camera)
      features.push({
        type: "Feature",
        properties: { kind: "camera" },
        geometry: { type: "Point", coordinates: camera },
      });
    if (place.target)
      features.push({
        type: "Feature",
        properties: { kind: "target" },
        geometry: { type: "Point", coordinates: place.target },
      });
    if (camera && place.target)
      features.push({
        type: "Feature",
        properties: { kind: "sight" },
        geometry: { type: "LineString", coordinates: [camera, place.target] },
      });
    setup?.tracks.forEach((t, track) => {
      const seg = tracks.segments.find((s) => s.id === t.segment);
      if (seg)
        features.push({
          type: "Feature",
          properties: { track },
          geometry: { type: "LineString", coordinates: seg.coords },
        });
    });
    void source.setData({ type: "FeatureCollection", features });
  }, [map, tracks, camera, place.target, setup, styleGeneration]);

  return (
    <div className="absolute inset-x-0 bottom-0 z-50 max-h-[55dvh] overflow-y-auto overscroll-contain border-t border-gray-300 bg-white p-4 text-sm text-gray-900 shadow-lg lg:left-5 lg:right-auto lg:bottom-5 lg:w-[28rem] lg:rounded-lg lg:border dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100">
      <h1 className="mb-1 text-base font-semibold">Trackside camera: setup</h1>
      {tracksError && (
        <p className="text-red-700 dark:text-red-400">{tracksError}</p>
      )}
      <p className="mb-2 text-gray-600 dark:text-gray-400">
        {tapSets === "camera" ?
          "Tap where the camera is."
        : "Tap the guideway where the middle of the camera's view is."}
      </p>
      <ul className="mb-3 space-y-1">
        <li>
          <span className="mr-1 inline-block h-2.5 w-2.5 rounded-full bg-blue-600" />
          Camera:{" "}
          {place.camera ?
            "set on the map"
          : gps ?
            `GPS, ±${Math.round(gps.accuracy)} m`
          : (gpsError ?? "waiting for GPS…")}
          {" · "}
          <button className="underline" onClick={() => setTapSets("camera")}>
            set on map
          </button>
          {place.camera && (
            <>
              {" · "}
              <button
                className="underline"
                onClick={() => setPlace((p) => ({ ...p, camera: undefined }))}>
                use GPS
              </button>
            </>
          )}
        </li>
        <li>
          <span className="mr-1 inline-block h-2.5 w-2.5 rounded-full bg-red-600" />
          View: {place.target ? "set" : "tap the guideway"}
        </li>
      </ul>
      {result && "error" in result && (
        <p className="mb-2 text-red-700 dark:text-red-400">{result.error}</p>
      )}
      {setup && <SetupSummary setup={setup} />}
      <div className="mt-3 flex flex-wrap gap-2">
        <button className={primary} disabled={!setup} onClick={() => start()}>
          Start camera
        </button>
        <button
          className={button}
          disabled={!setup}
          onClick={() => fileInput.current?.click()}>
          Test with a video…
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="video/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) start(file);
          }}
        />
      </div>
    </div>
  );
}

function SetupSummary({ setup }: { setup: CameraSetup }) {
  const lines = setup.lines
    .map((l) => l[0]!.toUpperCase() + l.slice(1))
    .join(", ");
  return (
    <div className="rounded border border-gray-200 p-2 dark:border-gray-700">
      <div>
        {lines || "SkyTrain"}: {setup.tracks.length}{" "}
        {setup.tracks.length === 1 ? "track" : "tracks"} in view
      </div>
      <ul>
        {setup.tracks.map((t, i) => (
          <li key={t.segment} className={TRACK_TEXT[i]}>
            {trackNames(setup.tracks.length)[i]!.replace(/^./, (c) =>
              c.toUpperCase(),
            )}
            {setup.tracks.length > 1 ? " track" : ""}:{" "}
            {t.kind === "main" ? "main line" : t.kind},{" "}
            {Math.round(t.distanceM)} m away
          </li>
        ))}
      </ul>
      <div>
        → {compass(setup.rightwardBearing)}
        {setup.towardRight && ` toward ${setup.towardRight}`}
      </div>
      <div>
        ← {compass((setup.rightwardBearing + 180) % 360)}
        {setup.towardLeft && ` toward ${setup.towardLeft}`}
      </div>
    </div>
  );
}

/** Track colours as on the map and camera view, nearest first. */
const TRACK_TEXT = [
  "text-green-700 dark:text-green-400",
  "text-amber-700 dark:text-amber-400",
  "text-violet-700 dark:text-violet-400",
];

/** "eastbound" etc. for a bearing. */
export function compass(bearing: number): string {
  const names = [
    "northbound",
    "northeastbound",
    "eastbound",
    "southeastbound",
    "southbound",
    "southwestbound",
    "westbound",
    "northwestbound",
  ];
  return names[Math.round(bearing / 45) % 8]!;
}

const emptyFc = (): GeoJSON.FeatureCollection => ({
  type: "FeatureCollection",
  features: [],
});
