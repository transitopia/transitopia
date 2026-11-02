// AIS feed (packages/transit-core/DESIGN.md#seabus-ais): one WebSocket to aisstream.io per leader
// process (AisStream), subscribed to every feed's vessels and bounding boxes, which hands each fix
// to its vessel's feed (AisFeed). aisstream.io allows 3 connections per account (DATA-LICENSES.md),
// so feeds share the one. Each feed's fixes are kept in memory for the last two days, recorded in
// batches with the RT recorder format (var/ais-history/<feed>/, same hourly files and coverage
// index), and served per service date (dayFile) and as a trailing window for the live endpoint
// (liveWindow), both by batch time so the two meet without a gap. Client requests never touch the
// upstream connection.

import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { decodeSnapshot } from "@transitopia/transit-core/rt/types.ts";
import {
  fixToVehicle,
  parseAisMessage,
  serviceDateWindow,
  vehicleToFix,
} from "@transitopia/transit-core/ais/fixes.ts";
import type { AisFix } from "@transitopia/transit-core/ais/match.ts";
import {
  addDays,
  localDate,
  type ServiceDate,
} from "@transitopia/transit-core/time.ts";
import { hourKey, type Recorder } from "./recorder.ts";

const URL = "wss://stream.aisstream.io/v0/stream";
/** Keep this much history in memory (ms); older dates are read from the recorder's files. */
const MEMORY_MS = 48 * 3_600_000;
const PAST_DATES_CACHED = 7;
/** A date's fixes are all recorded this long after its window ends (a batch or two). */
const COMPLETE_AFTER_BATCHES = 2;
/** The first reconnect waits this long (s), doubling up to the feeds' longest maxBackoffS. */
const MIN_BACKOFF_S = 5;

export interface AisConfig {
  vessels: { mmsi: string; name: string }[];
  boundingBox: [[number, number], [number, number]];
  batchS: number;
  maxBackoffS: number;
}

/** A fix in memory: `at` is its batch's time, once recorded. */
type HeldFix = AisFix & { at?: number };

type Socket = Pick<WebSocket, "send" | "close" | "addEventListener">;

export interface AisFeedOptions {
  cfg: AisConfig;
  route: string;
  /** The feed's time zone: its service dates. */
  timezone: string;
  recorder: Recorder;
  record?: boolean;
  log?: (msg: string) => void;
  /** Also called with each batch (e.g. to record it in the database). */
  onBatch?: (receivedAt: number, fixes: AisFix[]) => Promise<void>;
}

export interface AisStreamOptions {
  apiKey: string;
  log?: (msg: string) => void;
  /** For tests. */
  connect?: (url: string) => Socket;
}

/** The one aisstream.io connection, shared by every feed with vessels (`add`). */
export class AisStream {
  private feeds: AisFeed[] = [];
  /** Each vessel's feed, by MMSI. */
  private byMmsi = new Map<string, AisFeed>();
  private socket: Socket | undefined;
  private running = false;
  private backoffS = MIN_BACKOFF_S;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastMessageAt: number | undefined;
  private lastError: string | undefined;
  private messages = 0;
  private log: (msg: string) => void;
  private opts: AisStreamOptions;
  connected = false;

  constructor(opts: AisStreamOptions) {
    this.opts = opts;
    this.log = opts.log ?? ((m) => console.log(`[ais] ${m}`));
  }

  /** A feed's vessels and bounding box join the subscription (before `start`). */
  add(feed: AisFeed): void {
    this.feeds.push(feed);
    for (const v of feed.cfg.vessels) this.byMmsi.set(v.mmsi, feed);
    feed.stream = this;
  }

  /** Start every feed added (resuming its recordings), then connect. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    for (const feed of this.feeds) await feed.start();
    this.connect();
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.timer);
    for (const feed of this.feeds) feed.stop();
    this.socket?.close();
    this.socket = undefined;
    this.connected = false;
  }

  status() {
    return {
      connected: this.connected,
      messages: this.messages,
      lastMessageAgeS:
        this.lastMessageAt ?
          Math.round((Date.now() - this.lastMessageAt) / 1000)
        : null,
      lastError: this.lastError ?? null,
    };
  }

  private connect(): void {
    if (!this.running) return;
    const socket = (this.opts.connect ?? ((url) => new WebSocket(url)))(URL);
    this.socket = socket;
    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({
          APIKey: this.opts.apiKey,
          BoundingBoxes: this.feeds.map((f) => f.cfg.boundingBox),
          FiltersShipMMSI: [...this.byMmsi.keys()],
          FilterMessageTypes: ["PositionReport"],
        }),
      );
    });
    socket.addEventListener("message", (ev) => void this.onMessage(ev.data));
    socket.addEventListener("error", () => {
      this.lastError = "WebSocket error";
    });
    socket.addEventListener("close", (ev) => {
      if (this.socket !== socket) return;
      this.connected = false;
      this.socket = undefined;
      if (!this.running) return;
      if (ev.reason) this.lastError = ev.reason;
      this.log(
        `Disconnected (${ev.code}${ev.reason ? ` ${ev.reason}` : ""}); reconnecting in ${this.backoffS}s`,
      );
      this.timer = setTimeout(() => this.connect(), this.backoffS * 1000);
      this.backoffS = Math.min(
        Math.max(MIN_BACKOFF_S, ...this.feeds.map((f) => f.cfg.maxBackoffS)),
        this.backoffS * 2,
      );
    });
  }

  private async onMessage(data: unknown): Promise<void> {
    const text =
      typeof data === "string" ? data : (
        Buffer.from(
          data instanceof Blob ?
            await data.arrayBuffer()
          : (data as ArrayBuffer),
        ).toString("utf8")
      );
    let msg: { MessageType?: string; error?: string };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    this.lastMessageAt = Date.now();
    this.messages++;
    if (msg.error) {
      this.lastError = String(msg.error);
      this.log(`Upstream error: ${this.lastError}`);
      return;
    }
    if (msg.MessageType === "SubscriptionConfirmation") {
      if (!this.connected)
        this.log(`Connected; tracking ${this.byMmsi.size} vessels`);
      this.connected = true;
      this.backoffS = MIN_BACKOFF_S;
      this.lastError = undefined;
      return;
    }
    const fix = parseAisMessage(msg, new Set(this.byMmsi.keys()));
    if (fix) this.byMmsi.get(fix.mmsi)?.accept(fix);
  }
}

export class AisFeed {
  /** Fixes in memory, in arrival order. */
  private fixes: HeldFix[] = [];
  private pending: HeldFix[] = [];
  /** When the latest batch was recorded, and the latest one with fixes in it. */
  private lastBatchAt: number | undefined;
  private lastFixBatchAt: number | undefined;
  private past = new Map<string, AisFix[]>();
  private running = false;
  private batchTimer: ReturnType<typeof setInterval> | undefined;
  private log: (msg: string) => void;
  private opts: AisFeedOptions;
  /** The connection its vessels' fixes come in on (`AisStream.add`). */
  stream: AisStream | undefined;

  constructor(opts: AisFeedOptions) {
    this.opts = opts;
    this.log = opts.log ?? ((m) => console.log(`[ais] ${m}`));
  }

  get cfg(): AisConfig {
    return this.opts.cfg;
  }

  private get connected(): boolean {
    return this.stream?.connected ?? false;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.opts.recorder.init();
    // Resume today's and yesterday's fixes from disk after a restart.
    const { recorder, timezone } = this.opts;
    const today = localDate(Date.now(), timezone);
    const resumed = dedupe([
      ...(await readRecordedFixes(recorder, addDays(today, -1), timezone)),
      ...(await readRecordedFixes(recorder, today, timezone)),
    ]);
    // Recorded before this process: older than any live window.
    this.fixes = resumed.map((f) => ({ ...f, at: 0 }));
    this.lastBatchAt = Date.now();
    this.batchTimer = setInterval(
      () => void this.flush(),
      this.opts.cfg.batchS * 1000,
    );
  }

  stop(): void {
    this.running = false;
    if (this.batchTimer) clearInterval(this.batchTimer);
  }

  /** The shared connection's status, with this feed's fixes in memory. */
  status() {
    return {
      connected: false,
      messages: 0,
      lastMessageAgeS: null,
      lastError: null,
      ...this.stream?.status(),
      fixesInMemory: this.fixes.length,
    };
  }

  /** A fix of one of its vessels, from the stream. */
  accept(fix: AisFix): void {
    if (!this.running) return;
    this.fixes.push(fix);
    this.pending.push(fix);
  }

  /** A past service date's fixes (YYYYMMDD), sorted by time, read from the recordings. */
  private async pastFixes(serviceDate: ServiceDate): Promise<AisFix[]> {
    let cached = this.past.get(serviceDate);
    if (!cached) {
      cached = await readRecordedFixes(
        this.opts.recorder,
        serviceDate,
        this.opts.timezone,
      );
      this.past.set(serviceDate, cached);
      while (this.past.size > PAST_DATES_CACHED)
        this.past.delete(this.past.keys().next().value!);
    }
    return cached;
  }

  /**
   * A service date's fixes recorded so far (sorted by time), complete through `to`: every batch
   * recorded up to then is in them. `complete` once the date's window is over and recorded.
   */
  async dayFile(
    serviceDate: ServiceDate,
    now = Date.now(),
  ): Promise<{ fixes: AisFix[]; to: number; complete: boolean }> {
    const [from, to] = serviceDateWindow(serviceDate, this.opts.timezone);
    const complete =
      now > to + COMPLETE_AFTER_BATCHES * this.opts.cfg.batchS * 1000;
    if (from < now - MEMORY_MS)
      return { fixes: await this.pastFixes(serviceDate), to, complete: true };
    const fixes = this.fixes
      .filter((f) => f.at !== undefined && f.ts >= from && f.ts < to)
      .map(strip)
      .sort((a, b) => a.ts - b.ts);
    return { fixes, to: this.lastBatchAt ?? 0, complete };
  }

  /**
   * The batches recorded in the `windowMs` up to the latest one with fixes: those after `from`, up
   * to and including `to`. Anchored to data rather than the request time, so the result only
   * changes when a batch brings fixes.
   */
  liveWindow(windowMs: number): { fixes: AisFix[]; from: number; to: number } {
    const to = this.lastFixBatchAt ?? this.lastBatchAt ?? 0;
    const from = to - windowMs;
    const fixes = this.fixes
      .filter((f) => f.at !== undefined && f.at > from && f.at <= to)
      .map(strip)
      .sort((a, b) => a.ts - b.ts);
    return { fixes, from, to };
  }

  /** When the next batch is expected to bring fixes: the next one after a batch that did, else unknown. */
  nextBatchAt(): number | undefined {
    if (!this.connected || this.lastBatchAt === undefined) return undefined;
    if (this.lastFixBatchAt !== this.lastBatchAt) return undefined;
    return this.lastBatchAt + this.opts.cfg.batchS * 1000;
  }

  /** Record pending fixes (an empty batch while connected keeps coverage going); prune memory. */
  private async flush(): Promise<void> {
    const now = Date.now();
    const held = this.pending;
    this.pending = [];
    for (const f of held) f.at = now;
    if (held.length || this.connected) {
      this.lastBatchAt = now;
      if (held.length) this.lastFixBatchAt = now;
    }
    const batch = held.map(strip);
    if (this.opts.record !== false && (batch.length || this.connected)) {
      await this.opts.recorder.record({
        fetchedAt: now,
        headerTs: now,
        vehicles: batch.map((f) => fixToVehicle(f, this.opts.route)),
      });
      await this.opts
        .onBatch?.(now, batch)
        .catch((e: Error) => this.log(`could not record batch (${e.message})`));
    }
    const cutoff = now - MEMORY_MS;
    if (this.fixes.length && this.fixes[0]!.ts < cutoff)
      this.fixes = this.fixes.filter((f) => f.ts >= cutoff);
  }
}

function strip({ at: _, ...f }: HeldFix): AisFix {
  return f;
}

/** Recorded fixes that can belong to a service date's trips (see serviceDateWindow), sorted. */
export async function readRecordedFixes(
  recorder: Recorder,
  serviceDate: ServiceDate,
  tz: string,
): Promise<AisFix[]> {
  const [from, to] = serviceDateWindow(serviceDate, tz);
  const dates = [...new Set([hourKey(from).date, hourKey(to).date])];
  const out: AisFix[] = [];
  for (const date of dates) {
    for (let h = 0; h < 24; h++) {
      const f = await recorder.hourFile(date, String(h).padStart(2, "0"));
      if (!f) continue;
      const buf = await readFile(f.path);
      const text = (f.gzip ? gunzipSync(buf) : buf).toString("utf8");
      for (const line of text.split("\n"))
        if (line) out.push(...decodeSnapshot(line).vehicles.map(vehicleToFix));
    }
  }
  return dedupe(out.filter((f) => f.ts >= from && f.ts < to));
}

/** Sorted by time, without repeats (the same fix recorded twice, e.g. around a restart). */
function dedupe(fixes: AisFix[]): AisFix[] {
  const seen = new Set<string>();
  return fixes
    .sort((a, b) => a.ts - b.ts)
    .filter((f) => {
      const k = `${f.mmsi}|${f.ts}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}
