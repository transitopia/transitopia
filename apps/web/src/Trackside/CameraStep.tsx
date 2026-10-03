// /trackside camera view (packages/trackside/README.md#the-trackside-page): the live preview with a band per
// track in view to drag into place, what the detector sees moving, and the passes found with their
// track (correctable, which also sets that track's band), car numbers and upload state.

import React from "react";
import { trainsets } from "@transitopia/trackside/cars.ts";
import type { CameraSetup } from "@transitopia/trackside/types.ts";
import {
  roiOf,
  TracksideSession,
  type Bands,
  type PassView,
  type Snapshot,
} from "./session.ts";
import { compass } from "./SetupStep.tsx";

const button =
  "rounded border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-100 disabled:opacity-50 dark:border-gray-600 dark:hover:bg-gray-800";
const MIN_BAND = 0.03;
/** Track colours, nearest track first: fill, border, text. */
const COLORS = [
  {
    bg: "bg-green-600",
    border: "border-green-500",
    text: "text-green-700 dark:text-green-400",
  },
  {
    bg: "bg-amber-600",
    border: "border-amber-500",
    text: "text-amber-700 dark:text-amber-400",
  },
  {
    bg: "bg-violet-600",
    border: "border-violet-500",
    text: "text-violet-700 dark:text-violet-400",
  },
];
/** Most of the screen's height the preview may take, in dvh. */
const PREVIEW_MAX_DVH = 55;

export function CameraStep({
  setup,
  file,
  token,
  onBack,
}: {
  setup: CameraSetup;
  file?: File | undefined;
  token: string | undefined;
  onBack: () => void;
}) {
  // Made in the effect, not during render, so StrictMode's remount gets a fresh session.
  const [session, setSession] = React.useState<TracksideSession>();
  const videoBox = React.useRef<HTMLDivElement>(null);
  const [showImages, setShowImages] = React.useState(false);

  React.useEffect(() => {
    const s = new TracksideSession(setup, token);
    s.video.className = "block h-full w-full";
    videoBox.current!.prepend(s.video);
    setSession(s);
    void (file ? s.startFile(file) : s.startCamera());
    return () => {
      s.dispose();
      s.video.remove();
    };
  }, [setup, token, file]);

  const snap = React.useSyncExternalStore(
    React.useCallback(
      (fn: () => void) => session?.subscribe(fn) ?? (() => {}),
      [session],
    ),
    () => session?.snapshot,
  );

  // The preview keeps the video's shape and at most PREVIEW_MAX_DVH of the screen's height, so the
  // controls stay reachable (the overlay's fractions are of this box).
  const aspect = snap?.video ? snap.video.width / snap.video.height : 16 / 9;
  return (
    <div className="min-h-dvh bg-gray-100 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
      {snap && session && <StatusBar snap={snap} onBack={onBack} />}
      <div
        ref={videoBox}
        className="relative mx-auto select-none bg-black"
        style={{
          aspectRatio: String(aspect),
          width: `min(100%, ${PREVIEW_MAX_DVH * aspect}dvh)`,
        }}>
        {snap?.video && session && (
          <BandsOverlay
            bands={snap.bands}
            snap={snap}
            onChange={(b) => session.setBands(b)}
          />
        )}
      </div>
      {snap && session && (
        <Controls
          session={session}
          setup={setup}
          snap={snap}
          showImages={showImages}
          setShowImages={setShowImages}
        />
      )}
    </div>
  );
}

/** Always in view at the top: back to setup, and whether the camera, reader and uploads work. */
function StatusBar({ snap, onBack }: { snap: Snapshot; onBack: () => void }) {
  const sent = snap.passes.filter((p) => p.upload === "sent").length;
  const waiting = snap.passes.filter(
    (p) => p.upload === "waiting" || p.upload === "sending",
  ).length;
  return (
    <div className="sticky top-0 z-10 border-b border-gray-300 bg-white/95 px-3 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))] text-sm dark:border-gray-700 dark:bg-gray-900/95">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-4 gap-y-1">
        <button className={button} onClick={onBack}>
          ← Setup
        </button>
        <span>
          {snap.state === "error" ?
            <span className="text-red-700 dark:text-red-400">{snap.error}</span>
          : snap.state === "running" ?
            `${snap.source === "file" ? "Clip" : "Camera"} ${snap.video?.width}×${snap.video?.height}, ${snap.fps} fps, ${snap.frameMs} ms/frame`
          : "Starting…"}
        </span>
        <span>
          Reader:{" "}
          {snap.ocr.state === "loading" ?
            `loading ${Math.round(snap.ocr.progress * 100)} %`
          : snap.ocr.state === "error" ?
            <span className="text-red-700 dark:text-red-400">
              {snap.ocr.error}
            </span>
          : snap.ocr.state}
        </span>
        {snap.source === "camera" && (
          <span>
            Uploaded {sent}
            {waiting ? `, ${waiting} waiting` : ""}
          </span>
        )}
        {snap.source === "file" && <span>Clip: passes aren't uploaded</span>}
      </div>
      {snap.video && snap.video.height > snap.video.width && (
        <p className="mx-auto mt-2 max-w-5xl rounded bg-amber-100 p-2 text-amber-900 dark:bg-amber-900 dark:text-amber-100">
          Turn the phone sideways: trains cross a landscape view, and the
          detector needs the width.
        </p>
      )}
    </div>
  );
}

function Controls({
  session,
  setup,
  snap,
  showImages,
  setShowImages,
}: {
  session: TracksideSession;
  setup: CameraSetup;
  snap: Snapshot;
  showImages: boolean;
  setShowImages: (show: boolean) => void;
}) {
  return (
    // Bottom padding clears Safari's floating toolbar and the home indicator.
    <div className="mx-auto max-w-5xl space-y-3 p-3 pb-[calc(env(safe-area-inset-bottom)+6rem)] text-sm">
      {snap.zoom && snap.zoom.max > snap.zoom.min && (
        <label className="flex items-center gap-2">
          Zoom
          <input
            type="range"
            min={snap.zoom.min}
            max={snap.zoom.max}
            step={snap.zoom.step || 0.1}
            value={snap.zoom.value}
            onChange={(e) => void session.setZoom(Number(e.target.value))}
            className="w-48"
          />
          {snap.zoom.value.toFixed(1)}×
        </label>
      )}
      <p className="text-gray-600 dark:text-gray-400">
        {setup.tracks.length === 1 ?
          "Drag the band's ends (on the right) to the top and bottom of the trains."
        : `Drag each track's band (its ends are on the right) to where that track's trains appear: from above, the tracks are separate lanes; from level, the near track's trains look taller.`
        }{" "}
        Moving things are outlined in their track's colour. Or, after a train
        passes, tap the track it was on: that sets its band. Car numbers read
        best when they're large: zoom in if you can.
      </p>
      <ul className="flex flex-wrap gap-x-4">
        {setup.tracks.map((t, i) => (
          <li key={t.segment} className={COLORS[i]!.text}>
            Track {i + 1}: {t.kind === "main" ? "main line" : t.kind},{" "}
            {Math.round(t.distanceM)} m
          </li>
        ))}
      </ul>
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Passes</h2>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={showImages}
            onChange={(e) => setShowImages(e.target.checked)}
          />
          Show train images (this phone only)
        </label>
      </div>
      {!snap.passes.length && <p className="text-gray-500">None yet.</p>}
      <ul className="space-y-2">
        {snap.passes.map((p) => (
          <PassRow
            key={p.report.id}
            pass={p}
            tracks={setup.tracks.length}
            showImage={showImages}
            onTrack={(t) => session.setPassTrack(p.report.id, t)}
          />
        ))}
      </ul>
    </div>
  );
}

function PassRow({
  pass,
  tracks,
  showImage,
  onTrack,
}: {
  pass: PassView;
  tracks: number;
  showImage: boolean;
  onTrack: (track: number) => void;
}) {
  const r = pass.report;
  const time = new Date(r.start).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  return (
    <li className="rounded border border-gray-300 bg-white p-2 dark:border-gray-700 dark:bg-gray-900">
      <div className="flex flex-wrap gap-x-3">
        <span className="font-mono">{time}</span>
        <span className="flex items-center gap-1">
          Track
          {Array.from({ length: tracks }, (_, i) => (
            <button
              key={i}
              title={`Track ${i + 1}: also sets that track's band to this train`}
              className={`h-7 w-7 rounded border text-sm ${
                r.track === i ?
                  `${COLORS[i]!.bg} border-transparent text-white`
                : "border-gray-300 dark:border-gray-600"
              }`}
              onClick={() => onTrack(i)}>
              {i + 1}
            </button>
          ))}
          {r.track === undefined && <span className="text-gray-500">?</span>}
          {r.occluded ? " (partly hidden)" : ""}
        </span>
        <span>
          {r.screen === "right" ? "→" : "←"} {compass(r.bearing)}
          {r.toward && ` toward ${r.toward}`}
        </span>
        <span>
          {r.speedKmh !== null ? `~${r.speedKmh} km/h` : `${r.pxPerS} px/s`}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3">
        <span>
          Cars:{" "}
          {pass.reading === "pending" ?
            "reading…"
          : r.cars.length ?
            <span className="font-mono">
              {trainsets(r.cars.map((c) => c.number)).join("  ")}
            </span>
          : "none read"}
        </span>
        {!!r.uncertain?.length && (
          <span className="text-gray-500">{r.uncertain.length} uncertain</span>
        )}
        {pass.readMs !== undefined && (
          <span className="text-gray-500">
            {(pass.readMs / 1000).toFixed(1)} s to read
          </span>
        )}
        <span
          className={
            pass.upload === "failed" ?
              "text-red-700 dark:text-red-400"
            : "text-gray-500"
          }>
          {pass.upload === "local" ? "" : pass.upload}
          {pass.error && `: ${pass.error}`}
        </span>
      </div>
      {showImage && pass.thumbnail && (
        <div className="mt-1 overflow-x-auto">
          <img src={pass.thumbnail} alt="" className="h-[72px] max-w-none" />
        </div>
      )}
    </li>
  );
}

/**
 * The tracks' bands over the video. Each has a bar on the right, one column per track, with
 * handles at its ends to drag; thin lines across the preview show its edges. What's moving is
 * outlined in the colour of the track it matches (white: none).
 */
function BandsOverlay({
  bands,
  snap,
  onChange,
}: {
  bands: Bands;
  snap: Snapshot;
  onChange: (bands: Bands) => void;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [drag, setDrag] = React.useState<{ band: number; end: 0 | 1 }>();
  const move = (e: React.PointerEvent) => {
    if (!drag || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    const next = bands.map((b) => [...b] as [number, number]);
    const band = next[drag.band]!;
    band[drag.end] = y;
    if (band[1] - band[0] < MIN_BAND) return;
    onChange(next);
  };
  const pct = (f: number) => `${(f * 100).toFixed(2)}%`;
  const [roiTop, roiBottom] = roiOf(bands);
  return (
    <div
      ref={ref}
      className="absolute inset-0"
      onPointerMove={move}
      onPointerUp={() => setDrag(undefined)}
      onPointerCancel={() => setDrag(undefined)}>
      {/* Outside the region of interest isn't processed. */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0 bg-black/40"
        style={{ height: pct(roiTop) }}
      />
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 bg-black/40"
        style={{ top: pct(roiBottom) }}
      />
      <div className="pointer-events-none absolute inset-y-0 left-1/2 w-px bg-white/50" />
      {snap.objects.map((o, i) => (
        <div
          key={i}
          className={`pointer-events-none absolute inset-x-1 border-2 ${o.track === undefined ? "border-white" : COLORS[o.track]!.border}`}
          style={{ top: pct(o.top), height: pct(o.bottom - o.top) }}
        />
      ))}
      {bands.map(([top, bottom], i) => {
        const c = COLORS[i]!;
        const right = `${0.5 + i * 2.75}rem`;
        const handle = (end: 0 | 1) => (
          <div
            className="absolute -mr-3 -mt-3 flex h-6 w-6 cursor-ns-resize touch-none items-center justify-center"
            style={{
              top: pct(end ? bottom : top),
              right: `calc(${right} + 0.25rem)`,
            }}
            onPointerDown={(e) => {
              (e.target as HTMLElement).setPointerCapture(e.pointerId);
              setDrag({ band: i, end });
            }}>
            <div
              className={`h-4 w-4 rounded-full border-2 border-white ${c.bg}`}
            />
          </div>
        );
        return (
          <React.Fragment key={i}>
            <div
              className={`pointer-events-none absolute inset-x-0 h-px ${c.bg} opacity-70`}
              style={{ top: pct(top) }}
            />
            <div
              className={`pointer-events-none absolute inset-x-0 h-px ${c.bg} opacity-70`}
              style={{ top: pct(bottom) }}
            />
            <div
              className={`pointer-events-none absolute flex w-2 items-center justify-center rounded ${c.bg}`}
              style={{ top: pct(top), height: pct(bottom - top), right }}>
              <span className={`rounded px-1 text-xs text-white ${c.bg}`}>
                {i + 1}
              </span>
            </div>
            {handle(0)}
            {handle(1)}
          </React.Fragment>
        );
      })}
    </div>
  );
}
