// /trackside camera view (packages/trackside/README.md#the-trackside-page): the live preview fills the screen,
// with small controls over it that open panels: status (top right), the tracks' bands and zoom
// (bottom left), and the passes found (bottom right), each with its track (correctable, which also
// sets that track's band), car numbers and upload state. Meant for a phone held sideways, run from
// the home screen without the browser's bars (Trackside.tsx).

import React from "react";
import { trainsets } from "@transitopia/trackside/cars.ts";
import { trackNames, type CameraSetup } from "@transitopia/trackside/types.ts";
import {
  roiOf,
  TracksideSession,
  type Bands,
  type PassView,
  type Snapshot,
} from "./session.ts";
import { compass } from "./SetupStep.tsx";

const MIN_BAND = 0.03;
/** Track colours, nearest track first. */
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
/** Controls over the preview: dark, translucent, finger-sized. */
const chip =
  "pointer-events-auto flex min-h-11 items-center gap-2 rounded-full bg-black/60 px-4 text-sm text-white backdrop-blur hover:bg-black/75";
// Overlays keep clear of the notch, the home indicator and rounded corners.
const insetTop = "top-[max(0.75rem,env(safe-area-inset-top))]";
const insetBottom = "bottom-[max(0.75rem,env(safe-area-inset-bottom))]";
const insetLeft = "left-[max(0.75rem,env(safe-area-inset-left))]";
const insetRight = "right-[max(0.75rem,env(safe-area-inset-right))]";

type Panel = "status" | "tracks" | "passes";

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
  const [panel, setPanel] = React.useState<Panel>();
  const toggle = (p: Panel) => setPanel((cur) => (cur === p ? undefined : p));

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

  // The preview is as large as fits, keeping the video's shape (the overlay's fractions are of it).
  const aspect = snap?.video ? snap.video.width / snap.video.height : 16 / 9;
  const editing = panel === "tracks";
  return (
    <div className="fixed inset-0 select-none overflow-hidden bg-black text-white">
      <div className="absolute inset-0 flex items-center justify-center">
        <div
          ref={videoBox}
          className="relative"
          style={{
            aspectRatio: String(aspect),
            width: `min(100vw, ${100 * aspect}dvh)`,
          }}>
          {snap?.video && session && (
            <BandsOverlay
              bands={snap.bands}
              snap={snap}
              editing={editing}
              onChange={(b) => session.setBands(b)}
            />
          )}
        </div>
      </div>
      <div className="pointer-events-none absolute inset-0">
        <button
          className={`${chip} absolute ${insetTop} ${insetLeft}`}
          onClick={onBack}
          aria-label="Back to setup">
          ← Setup
        </button>
        {/* While editing bands, only "Done" stays, so nothing covers their handles. */}
        {snap && !editing && (
          <button
            className={`${chip} absolute ${insetTop} ${insetRight} ${snap.state === "error" || snap.ocr.state === "error" ? "bg-red-700/80!" : ""}`}
            onClick={() => toggle("status")}>
            <StatusSummary snap={snap} />
          </button>
        )}
        {snap?.video && snap.video.height > snap.video.width && (
          <p className="absolute inset-x-6 top-1/3 rounded-xl bg-amber-500/90 p-3 text-center text-gray-950">
            Turn the phone sideways: trains cross a landscape view, and the
            detector needs the width.
          </p>
        )}
        {snap && (
          <div
            className={`absolute ${insetBottom} ${insetLeft} ${insetRight} flex items-end justify-between gap-2`}>
            <button
              className={`${chip} ${editing ? "bg-blue-700/90!" : ""}`}
              onClick={() => toggle("tracks")}>
              {editing ? "Done" : `Tracks (${setup.tracks.length})`}
            </button>
            {!editing && (
              <button
                className={`${chip} min-w-0`}
                onClick={() => toggle("passes")}>
                <LatestPass snap={snap} />
              </button>
            )}
          </div>
        )}
      </div>
      {snap && session && panel && (
        <Sheet side={panel === "tracks"} onClose={() => setPanel(undefined)}>
          {panel === "status" && <StatusPanel snap={snap} />}
          {panel === "tracks" && (
            <TracksPanel session={session} setup={setup} snap={snap} />
          )}
          {panel === "passes" && (
            <PassesPanel session={session} setup={setup} snap={snap} />
          )}
        </Sheet>
      )}
    </div>
  );
}

/**
 * A panel over the lower part of the preview (which stays visible above it), or, with `side`, a
 * column on the left that keeps the band handles on the right free to drag.
 */
function Sheet({
  children,
  side,
  onClose,
}: {
  children: React.ReactNode;
  side: boolean;
  onClose: () => void;
}) {
  const bottom =
    "bottom-[max(4.25rem,calc(env(safe-area-inset-bottom)+3.5rem))]";
  const place =
    side ?
      `${insetLeft} top-[max(4.25rem,calc(env(safe-area-inset-top)+3.5rem))] ${bottom} w-[min(20rem,45vw)]`
    : `${insetLeft} ${insetRight} ${bottom} max-h-[60dvh] lg:left-auto lg:w-[32rem]`;
  return (
    <div
      className={`absolute ${place} overflow-y-auto overscroll-contain rounded-xl bg-white/95 p-3 text-sm text-gray-900 shadow-lg dark:bg-gray-900/95 dark:text-gray-100`}>
      <button
        className="float-right -mr-1 -mt-1 h-9 w-9 rounded-full text-lg hover:bg-gray-200 dark:hover:bg-gray-800"
        onClick={onClose}
        aria-label="Close">
        ×
      </button>
      {children}
    </div>
  );
}

/** The status pill: frame rate, reader and uploads, at a glance. */
function StatusSummary({ snap }: { snap: Snapshot }) {
  const { sent, waiting, failed } = uploads(snap);
  if (snap.state === "error") return <span>Camera error</span>;
  if (snap.state !== "running") return <span>Starting…</span>;
  return (
    <>
      <span>{snap.fps} fps</span>
      <span>
        {snap.ocr.state === "loading" ?
          `reader ${Math.round(snap.ocr.progress * 100)} %`
        : snap.ocr.state === "error" ?
          "reader error"
        : snap.ocr.state === "ready" ?
          "reader ✓"
        : "reader…"}
      </span>
      {snap.source === "camera" ?
        <span>
          ↑{sent}
          {waiting ? ` ⋯${waiting}` : ""}
          {failed ? ` ✕${failed}` : ""}
        </span>
      : <span>clip</span>}
    </>
  );
}

function StatusPanel({ snap }: { snap: Snapshot }) {
  const { sent, waiting, failed } = uploads(snap);
  return (
    <div className="space-y-1">
      <h2 className="font-semibold">Status</h2>
      <p>
        {snap.state === "error" ?
          <span className="text-red-700 dark:text-red-400">{snap.error}</span>
        : snap.state === "running" ?
          `${snap.source === "file" ? "Clip" : "Camera"} ${snap.video?.width}×${snap.video?.height}, ${snap.fps} fps, ${snap.frameMs} ms per frame`
        : "Starting…"}
      </p>
      <p>
        Reader:{" "}
        {snap.ocr.state === "loading" ?
          `loading ${Math.round(snap.ocr.progress * 100)} % (~16 MB, once)`
        : snap.ocr.state === "error" ?
          <span className="text-red-700 dark:text-red-400">
            {snap.ocr.error}
          </span>
        : snap.ocr.state}
      </p>
      <p>
        {snap.source === "file" ?
          "A clip: passes aren't uploaded."
        : `Uploads: ${sent} sent, ${waiting} waiting, ${failed} failed.`}
      </p>
    </div>
  );
}

function TracksPanel({
  session,
  setup,
  snap,
}: {
  session: TracksideSession;
  setup: CameraSetup;
  snap: Snapshot;
}) {
  return (
    <div className="space-y-2">
      <h2 className="font-semibold">Tracks</h2>
      <ul className="flex flex-wrap gap-x-4">
        {setup.tracks.map((t, i) => (
          <li key={t.segment} className={COLORS[i]!.text}>
            {capitalize(trackNames(setup.tracks.length)[i]!)}:{" "}
            {t.kind === "main" ? "main line" : t.kind},{" "}
            {Math.round(t.distanceM)} m
          </li>
        ))}
      </ul>
      <p className="text-gray-600 dark:text-gray-400">
        The near track is the one closest to you (as on the setup map). Drag
        each band's ends (on the right of the preview) to where that track's
        trains appear: from above, the near track is lower on screen and the
        tracks are separate lanes; from level, the near track's trains look
        taller. Or, after a train passes, tap its track in Passes: that sets the
        band. Car numbers read best when they're large: zoom in if you can.
      </p>
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
            className="min-w-0 flex-1"
          />
          {snap.zoom.value.toFixed(1)}×
        </label>
      )}
    </div>
  );
}

function PassesPanel({
  session,
  setup,
  snap,
}: {
  session: TracksideSession;
  setup: CameraSetup;
  snap: Snapshot;
}) {
  const [showImages, setShowImages] = React.useState(false);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-4 pr-8">
        <h2 className="font-semibold">Passes</h2>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={showImages}
            onChange={(e) => setShowImages(e.target.checked)}
          />
          Train images (this phone only)
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

/** The latest pass in one line (or how many so far), to open the list. */
function LatestPass({ snap }: { snap: Snapshot }) {
  const p = snap.passes[0];
  if (!p) return <span>No passes yet</span>;
  const r = p.report;
  return (
    <span className="truncate">
      {r.screen === "right" ? "→" : "←"}{" "}
      {r.track === undefined ?
        "track ?"
      : trackLabel(r.track, r.setup.tracks.length)}
      {" · "}
      {p.reading === "pending" ?
        "reading…"
      : trainsets(r.cars.map((c) => c.number)).join(" ") || "no numbers"}
      {p.upload === "local" ? "" : ` · ${p.upload}`}
      {snap.passes.length > 1 ? ` (${snap.passes.length})` : ""}
    </span>
  );
}

/** "near track", "middle track", "far track", or "track". */
function trackLabel(index: number, count: number): string {
  const name = trackNames(count)[index] ?? "track";
  return name === "track" ? name : `${name} track`;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function uploads(snap: Snapshot) {
  const count = (...states: PassView["upload"][]) =>
    snap.passes.filter((p) => states.includes(p.upload)).length;
  return {
    sent: count("sent"),
    waiting: count("waiting", "sending"),
    failed: count("failed"),
  };
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
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-mono">{time}</span>
        <span className="flex items-center gap-1">
          Track
          {Array.from({ length: tracks }, (_, i) => (
            <button
              key={i}
              title={`${capitalize(trackLabel(i, tracks))}: also sets that track's band to this train`}
              className={`h-9 min-w-9 rounded border px-2 text-sm ${
                r.track === i ?
                  `${COLORS[i]!.bg} border-transparent text-white`
                : "border-gray-300 dark:border-gray-600"
              }`}
              onClick={() => onTrack(i)}>
              {tracks === 1 ? "✓" : capitalize(trackNames(tracks)[i]!)}
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
 * Over the video: what's moving, outlined in the colour of the track it matches (white: none), and
 * the tracks' bands. While editing, each band has a bar on the right, one column per track, with
 * handles at its ends to drag; otherwise only faint lines mark its edges.
 */
function BandsOverlay({
  bands,
  snap,
  editing,
  onChange,
}: {
  bands: Bands;
  snap: Snapshot;
  editing: boolean;
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
      <div className="pointer-events-none absolute inset-y-0 left-1/2 w-px bg-white/40" />
      {snap.objects.map((o, i) => (
        <div
          key={i}
          className={`pointer-events-none absolute inset-x-1 border-2 ${o.track === undefined ? "border-white" : COLORS[o.track]!.border}`}
          style={{ top: pct(o.top), height: pct(o.bottom - o.top) }}
        />
      ))}
      {bands.map(([top, bottom], i) => {
        const c = COLORS[i]!;
        const right = `${0.5 + i * 3}rem`;
        const handle = (end: 0 | 1) => (
          <div
            className="absolute -mr-4 -mt-4 flex h-8 w-8 cursor-ns-resize touch-none items-center justify-center"
            style={{
              top: pct(end ? bottom : top),
              right: `calc(${right} + 0.25rem)`,
            }}
            onPointerDown={(e) => {
              (e.target as HTMLElement).setPointerCapture(e.pointerId);
              setDrag({ band: i, end });
            }}>
            <div
              className={`h-5 w-5 rounded-full border-2 border-white ${c.bg}`}
            />
          </div>
        );
        return (
          <React.Fragment key={i}>
            <div
              className={`pointer-events-none absolute inset-x-0 h-px ${c.bg} ${editing ? "opacity-80" : "opacity-40"}`}
              style={{ top: pct(top) }}
            />
            <div
              className={`pointer-events-none absolute inset-x-0 h-px ${c.bg} ${editing ? "opacity-80" : "opacity-40"}`}
              style={{ top: pct(bottom) }}
            />
            {editing && (
              <>
                <div
                  className={`pointer-events-none absolute flex w-2 items-center justify-center rounded ${c.bg}`}
                  style={{ top: pct(top), height: pct(bottom - top), right }}>
                  <span className={`rounded px-1 text-xs text-white ${c.bg}`}>
                    {trackNames(bands.length)[i]}
                  </span>
                </div>
                {handle(0)}
                {handle(1)}
              </>
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}
