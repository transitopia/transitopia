// AIS feed (packages/transit-core/DESIGN.md#seabus-ais): one WebSocket to aisstream.io per leader process, filtered to the SeaBus
// fleet. Fixes are kept in memory for the last two days, recorded in batches with the RT recorder
// format (var/ais-history/, same hourly files and coverage index), and served per service date
// (dayFile) and as a trailing window for the live endpoint (liveWindow), both by batch time so the
// two meet without a gap. Client requests never touch the upstream connection.

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
  apiKey: string;
  cfg: AisConfig;
  route: string;
  recorder: Recorder;
  record?: boolean;
  log?: (msg: string) => void;
  /** Also called with each batch (e.g. to record it in the database). */
  onBatch?: (receivedAt: number, fixes: AisFix[]) => Promise<void>;
  /** For tests. */
  connect?: (url: string) => Socket;
}

export class AisFeed {
  /** Fixes in memory, in arrival order. */
  private fixes: HeldFix[] = [];
  private pending: HeldFix[] = [];
  /** When the latest batch was recorded, and the latest one with fixes in it. */
  private lastBatchAt: number | undefined;
  private lastFixBatchAt: number | undefined;
  private past = new Map<string, AisFix[]>();
  private socket: Socket | undefined;
  private connected = false;
  private running = false;
  private backoffS = 5;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private batchTimer: ReturnType<typeof setInterval> | undefined;
  private lastMessageAt: number | undefined;
  private lastError: string | undefined;
  private messages = 0;
  private mmsis: Set<string>;
  private log: (msg: string) => void;

  private opts: AisFeedOptions;

  constructor(opts: AisFeedOptions) {
    this.opts = opts;
    this.mmsis = new Set(opts.cfg.vessels.map((v) => v.mmsi));
    this.log = opts.log ?? ((m) => console.log(`[ais] ${m}`));
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.opts.recorder.init();
    // Resume today's and yesterday's fixes from disk after a restart.
    const today = localDate(Date.now());
    const resumed = dedupe([
      ...(await readRecordedFixes(this.opts.recorder, addDays(today, -1))),
      ...(await readRecordedFixes(this.opts.recorder, today)),
    ]);
    // Recorded before this process: older than any live window.
    this.fixes = resumed.map((f) => ({ ...f, at: 0 }));
    this.lastBatchAt = Date.now();
    this.batchTimer = setInterval(
      () => void this.flush(),
      this.opts.cfg.batchS * 1000,
    );
    this.connect();
  }

  stop(): void {
    this.running = false;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    if (this.batchTimer) clearInterval(this.batchTimer);
    this.socket?.close();
    this.socket = undefined;
    this.connected = false;
  }

  status() {
    return {
      connected: this.connected,
      messages: this.messages,
      fixesInMemory: this.fixes.length,
      lastMessageAgeS:
        this.lastMessageAt ?
          Math.round((Date.now() - this.lastMessageAt) / 1000)
        : null,
      lastError: this.lastError ?? null,
    };
  }

  /** A past service date's fixes (YYYYMMDD), sorted by time, read from the recordings. */
  private async pastFixes(serviceDate: ServiceDate): Promise<AisFix[]> {
    let cached = this.past.get(serviceDate);
    if (!cached) {
      cached = await readRecordedFixes(this.opts.recorder, serviceDate);
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
    const [from, to] = serviceDateWindow(serviceDate);
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

  private connect(): void {
    if (!this.running) return;
    const socket = (this.opts.connect ?? ((url) => new WebSocket(url)))(URL);
    this.socket = socket;
    socket.addEventListener("open", () => {
      const { cfg } = this.opts;
      socket.send(
        JSON.stringify({
          APIKey: this.opts.apiKey,
          BoundingBoxes: [cfg.boundingBox],
          FiltersShipMMSI: [...this.mmsis],
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
      this.timers.push(setTimeout(() => this.connect(), this.backoffS * 1000));
      this.backoffS = Math.min(this.opts.cfg.maxBackoffS, this.backoffS * 2);
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
        this.log(`Connected; tracking ${this.mmsis.size} vessels`);
      this.connected = true;
      this.backoffS = 5;
      this.lastError = undefined;
      return;
    }
    const fix = parseAisMessage(msg, this.mmsis);
    if (!fix) return;
    this.fixes.push(fix);
    this.pending.push(fix);
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
): Promise<AisFix[]> {
  const [from, to] = serviceDateWindow(serviceDate);
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
