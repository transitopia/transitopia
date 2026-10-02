// A /trackside camera session (packages/trackside/README.md#the-trackside-page): frames from the camera (or a
// clip) go through the pass detector on the main thread; each pass's panorama goes to the reader
// worker; the report, with crops of the numbers read, is uploaded to the server. Nothing else
// leaves the phone. React reads `snapshot` with useSyncExternalStore, as with the transit engine.

import {
  PassDetector,
  type BandState,
  type DetectedPass,
} from "@transitopia/trackside/detector.ts";
import {
  speedKmh,
  travelBearing,
  zoomedHfov,
} from "@transitopia/trackside/geometry.ts";
import type { CameraSetup, PassReport } from "@transitopia/trackside/types.ts";
import { callApi } from "../Admin/api.ts";
import type { Rgba } from "@transitopia/trackside/image.ts";
import type { OcrRequest, OcrResponse, WorkerReading } from "./ocr-worker.ts";

/** The region of interest and split line, as fractions of the video height. */
export interface Roi {
  top: number;
  split: number;
  bottom: number;
}

export interface PassView {
  report: PassReport;
  reading: "pending" | "done" | "failed";
  readMs?: number | undefined;
  upload: "local" | "waiting" | "sending" | "sent" | "failed";
  error?: string | undefined;
  thumbnail?: string | undefined;
}

export interface Snapshot {
  state: "idle" | "starting" | "running" | "error";
  error?: string | undefined;
  source?: "camera" | "file" | undefined;
  near: BandState;
  far: BandState;
  /** Frames processed per second, and the detector's time per frame (ms). */
  fps: number;
  frameMs: number;
  ocr: {
    state: "idle" | "loading" | "ready" | "error";
    progress: number;
    error?: string | undefined;
  };
  passes: PassView[];
  roi: Roi;
  video?: { width: number; height: number } | undefined;
  zoom?: { min: number; max: number; step: number; value: number } | undefined;
}

const ROI_KEY = "transitopia:trackside-roi";
const DEFAULT_ROI: Roi = { top: 0.2, split: 0.45, bottom: 0.7 };
/** Panorama thumbnails in the debug list, in pixels. */
const THUMB_HEIGHT = 72;
const RETRY_MS = 15_000;
const idle: BandState = { moving: false, dx: 0, movingFraction: 0 };

export class TracksideSession {
  readonly video: HTMLVideoElement;
  private setup: CameraSetup;
  private readonly token: string | undefined;
  private snap: Snapshot;
  private readonly listeners = new Set<() => void>();
  private detector: PassDetector;
  private stream: MediaStream | undefined;
  private fileUrl: string | undefined;
  private readonly canvas = document.createElement("canvas");
  private worker: Worker | undefined;
  private frameHandle: number | undefined;
  private wakeLock: WakeLockSentinel | undefined;
  private retryTimer: number | undefined;
  private stats = { frames: 0, since: performance.now(), busyMs: 0 };
  /** For a clip: wall-clock ms at media time 0 (passes from clips are never uploaded). */
  private clipEpoch = 0;
  private disposed = false;

  constructor(setup: CameraSetup, token: string | undefined) {
    this.setup = setup;
    this.token = token;
    this.video = document.createElement("video");
    this.video.muted = true;
    this.video.playsInline = true;
    const roi = loadRoi();
    this.snap = {
      state: "idle",
      near: idle,
      far: idle,
      fps: 0,
      frameMs: 0,
      ocr: { state: "idle", progress: 0 },
      passes: [],
      roi,
    };
    this.detector = new PassDetector({ splitY: splitWithin(roi) });
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  get snapshot(): Snapshot {
    return this.snap;
  }

  private update(patch: Partial<Snapshot>): void {
    this.snap = { ...this.snap, ...patch };
    for (const fn of this.listeners) fn();
  }

  /** Start the rear camera. */
  async startCamera(): Promise<void> {
    this.update({ state: "starting", source: "camera", error: undefined });
    this.startReader();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 60 },
        },
      });
    } catch (e) {
      this.update({ state: "error", error: `Camera: ${(e as Error).message}` });
      return;
    }
    if (this.disposed) return this.stopStream();
    this.video.srcObject = this.stream;
    await this.video.play();
    const track = this.stream.getVideoTracks()[0];
    const caps = track?.getCapabilities?.() as
      | (MediaTrackCapabilities & {
          zoom?: { min: number; max: number; step: number };
        })
      | undefined;
    const settings = track?.getSettings() as
      (MediaTrackSettings & { zoom?: number }) | undefined;
    if (caps?.zoom)
      this.update({
        zoom: { ...caps.zoom, value: settings?.zoom ?? caps.zoom.min },
      });
    await this.keepAwake();
    this.run();
  }

  /** Replay a recorded clip instead (to test the detector; nothing is uploaded). */
  async startFile(file: File): Promise<void> {
    this.update({ state: "starting", source: "file", error: undefined });
    this.startReader();
    this.fileUrl = URL.createObjectURL(file);
    this.video.src = this.fileUrl;
    this.clipEpoch = file.lastModified;
    try {
      await this.video.play();
    } catch (e) {
      this.update({ state: "error", error: `Video: ${(e as Error).message}` });
      return;
    }
    this.video.onended = () => this.endPasses();
    this.run();
  }

  setRoi(roi: Roi): void {
    saveRoi(roi);
    this.detector.setSplit(splitWithin(roi));
    this.update({ roi });
  }

  async setZoom(value: number): Promise<void> {
    const track = this.stream?.getVideoTracks()[0];
    if (!track || !this.snap.zoom) return;
    await track
      .applyConstraints({
        advanced: [{ zoom: value } as MediaTrackConstraintSet],
      })
      .catch(() => {});
    this.update({ zoom: { ...this.snap.zoom, value } });
  }

  dispose(): void {
    this.disposed = true;
    this.endPasses();
    if (this.frameHandle !== undefined)
      this.video.cancelVideoFrameCallback(this.frameHandle);
    this.stopStream();
    this.video.pause();
    this.video.removeAttribute("src");
    if (this.fileUrl) URL.revokeObjectURL(this.fileUrl);
    this.worker?.terminate();
    void this.wakeLock?.release().catch(() => {});
    document.removeEventListener("visibilitychange", this.onVisibility);
    clearTimeout(this.retryTimer);
    this.listeners.clear();
  }

  private stopStream(): void {
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = undefined;
  }

  private run(): void {
    // Speeds need the real frame width, known only now.
    this.setup = {
      ...this.setup,
      frameWidth: this.video.videoWidth || this.setup.frameWidth,
    };
    this.update({
      state: "running",
      video: { width: this.video.videoWidth, height: this.video.videoHeight },
    });
    const onFrame = (now: number, meta: VideoFrameCallbackMetadata) => {
      if (this.disposed) return;
      this.frame(now, meta);
      this.frameHandle = this.video.requestVideoFrameCallback(onFrame);
    };
    this.frameHandle = this.video.requestVideoFrameCallback(onFrame);
  }

  private frame(now: number, meta: VideoFrameCallbackMetadata): void {
    const t0 = performance.now();
    const W = meta.width || this.video.videoWidth;
    const H = meta.height || this.video.videoHeight;
    const { top, bottom } = this.snap.roi;
    const y0 = Math.round(top * H);
    const h = Math.max(8, Math.round((bottom - top) * H));
    if (this.canvas.width !== W || this.canvas.height !== h) {
      this.canvas.width = W;
      this.canvas.height = h;
    }
    const ctx = this.canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(this.video, 0, y0, W, h, 0, 0, W, h);
    const img = ctx.getImageData(0, 0, W, h);
    // Camera frames are timed by the page's clock, clip frames by their media time.
    const t = this.snap.source === "file" ? meta.mediaTime : now / 1000;
    const ended = this.detector.push({ t, img });
    for (const p of ended) this.onPass(p);

    const s = this.stats;
    s.frames++;
    s.busyMs += performance.now() - t0;
    const elapsed = performance.now() - s.since;
    if (elapsed > 1000) {
      this.update({
        fps: Math.round((s.frames * 1000) / elapsed),
        frameMs: Math.round(s.busyMs / s.frames),
        near: this.detector.near,
        far: this.detector.far,
      });
      this.stats = { frames: 0, since: performance.now(), busyMs: 0 };
    } else if (
      this.detector.near.moving !== this.snap.near.moving
      || this.detector.far.moving !== this.snap.far.moving
    )
      this.update({ near: this.detector.near, far: this.detector.far });
  }

  private endPasses(): void {
    for (const p of this.detector.flush()) this.onPass(p);
  }

  /** Wall-clock time (ISO 8601) of a detector time. */
  private iso(t: number): string {
    const ms =
      this.snap.source === "file" ?
        this.clipEpoch + t * 1000
      : performance.timeOrigin + t * 1000;
    return new Date(ms).toISOString();
  }

  private onPass(p: DetectedPass): void {
    const setup = this.setup;
    const screen = p.direction > 0 ? "right" : "left";
    const distance =
      p.track === "far" ?
        (setup.farDistanceM ?? setup.nearDistanceM)
      : setup.nearDistanceM;
    const zoom = this.snap.zoom?.value ?? 1;
    const report: PassReport = {
      id: crypto.randomUUID(),
      setup,
      start: this.iso(p.startT),
      end: this.iso(p.endT),
      track: p.track,
      screen,
      bearing: travelBearing(setup, screen),
      toward: screen === "right" ? setup.towardRight : setup.towardLeft,
      speedKmh: speedKmh(
        p.pxPerS,
        distance,
        zoomedHfov(setup.hfovDeg, zoom),
        setup.frameWidth,
      ),
      pxPerS: Math.round(p.pxPerS),
      occluded: p.occluded,
      cars: [],
      source: this.snap.source ?? "camera",
    };
    this.update({
      passes: [
        {
          report,
          reading: "pending",
          upload: report.source === "file" ? "local" : "waiting",
        } satisfies PassView,
        ...this.snap.passes,
      ].slice(0, 100),
    });
    const msg: OcrRequest = {
      type: "read",
      id: report.id,
      pass: p,
      thumbnailHeight: THUMB_HEIGHT,
    };
    if (this.worker) this.worker.postMessage(msg, [p.panorama.data.buffer]);
    else this.finishPass(report.id, { reading: "failed", error: "No reader" });
  }

  private startReader(): void {
    if (this.worker) return;
    this.worker = new Worker(new URL("./ocr-worker.ts", import.meta.url), {
      type: "module",
    });
    this.update({ ocr: { state: "loading", progress: 0 } });
    this.worker.onmessage = (e: MessageEvent<OcrResponse>) => {
      const m = e.data;
      if (m.type === "progress")
        this.update({
          ocr: { state: "loading", progress: m.total ? m.loaded / m.total : 0 },
        });
      else if (m.type === "ready")
        this.update({ ocr: { state: "ready", progress: 1 } });
      else if (m.type === "error") {
        if (m.id)
          this.finishPass(m.id, { reading: "failed", error: m.message });
        else
          this.update({
            ocr: { state: "error", progress: 0, error: m.message },
          });
      } else if (m.type === "result") {
        const encode = (r: WorkerReading) => ({
          number: r.number,
          confidence: r.confidence,
          reads: r.reads,
          crop: jpeg(r.image, 0.85),
        });
        this.finishPass(m.id, {
          reading: "done",
          readMs: m.ms,
          thumbnail: jpeg(m.thumbnail, 0.7),
          cars: m.cars.map(encode),
          uncertain: m.uncertain.map(encode),
        });
      }
    };
    this.worker.onerror = (e) =>
      this.update({
        ocr: {
          state: "error",
          progress: 0,
          error: e.message || "Reader failed",
        },
      });
    this.worker.postMessage({ type: "load" } satisfies OcrRequest);
  }

  /** Reading finished (or failed): fill in the cars and upload. */
  private finishPass(
    id: string,
    r: {
      reading: "done" | "failed";
      readMs?: number;
      thumbnail?: string;
      cars?: PassReport["cars"];
      uncertain?: PassReport["cars"];
      error?: string;
    },
  ): void {
    this.patchPass(id, (v) => ({
      ...v,
      reading: r.reading,
      readMs: r.readMs,
      thumbnail: r.thumbnail,
      error: r.error,
      report: { ...v.report, cars: r.cars ?? [], uncertain: r.uncertain },
    }));
    void this.flushUploads();
  }

  private patchPass(id: string, fn: (v: PassView) => PassView): void {
    this.update({
      passes: this.snap.passes.map((v) => (v.report.id === id ? fn(v) : v)),
    });
  }

  /** Upload every finished pass that's waiting (oldest first); retry later on failure. */
  private async flushUploads(): Promise<void> {
    clearTimeout(this.retryTimer);
    const waiting = this.snap.passes
      .filter((v) => v.upload === "waiting" && v.reading !== "pending")
      .reverse();
    for (const v of waiting) {
      const id = v.report.id;
      this.patchPass(id, (x) => ({ ...x, upload: "sending" }));
      try {
        await callApi(this.token, "admin/api/trackside/passes", {
          method: "POST",
          body: JSON.stringify(v.report),
        });
        this.patchPass(id, (x) => ({ ...x, upload: "sent", error: undefined }));
      } catch (e) {
        const status = (e as { status?: number }).status;
        // Refused (bad report, not an admin): don't retry. Offline or server trouble: retry.
        const final = status !== undefined && status >= 400 && status < 500;
        this.patchPass(id, (x) => ({
          ...x,
          upload: final ? "failed" : "waiting",
          error: (e as Error).message,
        }));
        if (!final) {
          this.retryTimer = window.setTimeout(
            () => void this.flushUploads(),
            RETRY_MS,
          );
          return;
        }
      }
    }
  }

  private async keepAwake(): Promise<void> {
    try {
      this.wakeLock = await navigator.wakeLock?.request("screen");
    } catch {
      // Not allowed (e.g. low battery): the screen may lock and stop the camera.
    }
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  private onVisibility = () => {
    if (document.visibilityState === "visible" && !this.disposed)
      void navigator.wakeLock
        ?.request("screen")
        .then((l) => (this.wakeLock = l))
        .catch(() => {});
  };
}

/** The split line as a fraction of the ROI (the detector's terms). */
function splitWithin(roi: Roi): number {
  return Math.min(
    0.95,
    Math.max(
      0.05,
      (roi.split - roi.top) / Math.max(0.01, roi.bottom - roi.top),
    ),
  );
}

function loadRoi(): Roi {
  try {
    const r = JSON.parse(localStorage.getItem(ROI_KEY) ?? "null") as Roi | null;
    if (r && r.top < r.split && r.split < r.bottom) return r;
  } catch {
    // Use the default.
  }
  return DEFAULT_ROI;
}

function saveRoi(roi: Roi): void {
  try {
    localStorage.setItem(ROI_KEY, JSON.stringify(roi));
  } catch {
    // Only this session then.
  }
}

/** A JPEG data: URL of an image (small: number crops and thumbnails). */
function jpeg(img: Rgba, quality: number): string {
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  canvas
    .getContext("2d")!
    .putImageData(
      new ImageData(new Uint8ClampedArray(img.data), img.width, img.height),
      0,
      0,
    );
  return canvas.toDataURL("image/jpeg", quality);
}
