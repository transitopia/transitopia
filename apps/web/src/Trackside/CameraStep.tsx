// /trackside camera view (packages/trackside/README.md#the-trackside-page): the live preview with the region
// of interest and split line to drag into place, what the detector sees, and the passes found
// with their car numbers and upload state.

import React from "react";
import { pairs } from "@transitopia/trackside/cars.ts";
import type { CameraSetup } from "@transitopia/trackside/types.ts";
import {
  TracksideSession,
  type PassView,
  type Roi,
  type Snapshot,
} from "./session.ts";
import { compass } from "./SetupStep.tsx";

const button =
  "rounded border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-100 disabled:opacity-50 dark:border-gray-600 dark:hover:bg-gray-800";
const MIN_GAP = 0.03;

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
    s.video.className = "block w-full h-auto";
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

  return (
    <div className="min-h-dvh bg-gray-100 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
      <div
        ref={videoBox}
        className="relative mx-auto max-w-5xl touch-none select-none bg-black">
        {snap?.video && session && (
          <RoiOverlay
            roi={snap.roi}
            snap={snap}
            onChange={(r) => session.setRoi(r)}
          />
        )}
      </div>
      {snap && session && (
        <Controls
          session={session}
          snap={snap}
          onBack={onBack}
          showImages={showImages}
          setShowImages={setShowImages}
        />
      )}
    </div>
  );
}

function Controls({
  session,
  snap,
  onBack,
  showImages,
  setShowImages,
}: {
  session: TracksideSession;
  snap: Snapshot;
  onBack: () => void;
  showImages: boolean;
  setShowImages: (show: boolean) => void;
}) {
  const sent = snap.passes.filter((p) => p.upload === "sent").length;
  const waiting = snap.passes.filter(
    (p) => p.upload === "waiting" || p.upload === "sending",
  ).length;
  return (
    <div className="mx-auto max-w-5xl space-y-3 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
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
        <p className="rounded bg-amber-100 p-2 text-amber-900 dark:bg-amber-900 dark:text-amber-100">
          Turn the phone sideways: trains cross a landscape view, and the
          detector needs the width.
        </p>
      )}
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
        Drag the lines: the top one just above a near-track train's roof, the
        middle one just above far-track trains' roofs, the bottom one at the top
        of the near wall. Car numbers read best when they're large: zoom in if
        you can.
      </p>
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
          <PassRow key={p.report.id} pass={p} showImage={showImages} />
        ))}
      </ul>
    </div>
  );
}

function PassRow({ pass, showImage }: { pass: PassView; showImage: boolean }) {
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
        <span
          className={
            r.track === "near" ?
              "text-green-700 dark:text-green-400"
            : "text-amber-700 dark:text-amber-400"
          }>
          {r.track} track{r.occluded ? " (partly hidden)" : ""}
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
              {pairs(r.cars.map((c) => c.number)).join("  ")}
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

/** The ROI's top, split and bottom lines over the video, draggable, with the bands lit when moving. */
function RoiOverlay({
  roi,
  snap,
  onChange,
}: {
  roi: Roi;
  snap: { near: { moving: boolean }; far: { moving: boolean } };
  onChange: (roi: Roi) => void;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [drag, setDrag] = React.useState<keyof Roi>();
  const move = (e: React.PointerEvent) => {
    if (!drag || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    const next = { ...roi, [drag]: y };
    if (next.top + MIN_GAP > next.split || next.split + MIN_GAP > next.bottom)
      return;
    onChange(next);
  };
  const pct = (f: number) => `${(f * 100).toFixed(2)}%`;
  const line = (key: keyof Roi, label: string, color: string) => (
    <div
      className="absolute inset-x-0 -mt-4 flex h-8 cursor-ns-resize items-center"
      style={{ top: pct(roi[key]) }}
      onPointerDown={(e) => {
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        setDrag(key);
      }}>
      <div className={`h-0.5 w-full ${color}`} />
      <span
        className={`absolute right-1 rounded px-1 text-xs text-white ${color}`}>
        {label}
      </span>
    </div>
  );
  return (
    <div
      ref={ref}
      className="absolute inset-0"
      onPointerMove={move}
      onPointerUp={() => setDrag(undefined)}
      onPointerCancel={() => setDrag(undefined)}>
      <div
        className="pointer-events-none absolute inset-x-0 bg-black/40"
        style={{ top: 0, height: pct(roi.top) }}
      />
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 bg-black/40"
        style={{ top: pct(roi.bottom) }}
      />
      <div
        className={`pointer-events-none absolute inset-x-0 ${snap.near.moving ? "bg-green-500/30" : ""}`}
        style={{ top: pct(roi.top), height: pct(roi.bottom - roi.top) }}
      />
      <div
        className={`pointer-events-none absolute inset-x-0 ${snap.far.moving ? "bg-amber-500/30" : ""}`}
        style={{ top: pct(roi.split), height: pct(roi.bottom - roi.split) }}
      />
      <div className="pointer-events-none absolute inset-y-0 left-1/2 w-px bg-white/50" />
      {line("top", "near roof", "bg-green-600")}
      {line("split", "far roof", "bg-amber-600")}
      {line("bottom", "near wall", "bg-blue-600")}
    </div>
  );
}
