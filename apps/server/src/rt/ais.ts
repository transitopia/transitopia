// AIS feed (PLAN.md §4.12): one WebSocket to aisstream.io per leader process, filtered to the SeaBus
// fleet. Fixes are kept in memory for the last two days, recorded in batches with the RT recorder
// format (data/ais-history/, same hourly files and coverage index), and served per service date.
// Client requests never touch the upstream connection.

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
import { addDays, localDate } from "@transitopia/transit-core/time.ts";
import { hourKey, type Recorder } from "./recorder.ts";

const URL = "wss://stream.aisstream.io/v0/stream";
/** Keep this much history in memory (ms); older dates are read from the recorder's files. */
const MEMORY_MS = 48 * 3_600_000;
const PAST_DATES_CACHED = 7;

export interface AisConfig {
  vessels: { mmsi: string; name: string }[];
  boundingBox: [[number, number], [number, number]];
  batchS: number;
  maxBackoffS: number;
}

type Socket = Pick<WebSocket, "send" | "close" | "addEventListener">;

export interface AisFeedOptions {
  apiKey: string;
  cfg: AisConfig;
  route: string;
  recorder: Recorder;
  record?: boolean;
  log?: (msg: string) => void;
  /** For tests. */
  connect?: (url: string) => Socket;
}

export class AisFeed {
  /** Fixes in memory, in arrival order; seq numbers them for incremental fetches. */
  private fixes: (AisFix & { seq: number })[] = [];
  private seq = 0;
  /** Identifies this process's numbering: a client whose cursor has another epoch refetches. */
  readonly epoch = Date.now();
  private pending: AisFix[] = [];
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

  constructor(private opts: AisFeedOptions) {
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
    this.fixes = resumed.map((f) => ({ ...f, seq: ++this.seq }));
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

  /**
   * Fixes for a service date (YYYYMMDD), sorted by time. `after`: a cursor from an earlier call, to
   * get only fixes received since (they can arrive out of time order, in bursts).
   */
  async fixesFor(
    serviceDate: string,
    after = 0,
  ): Promise<{ fixes: AisFix[]; cursor: number }> {
    const [from, to] = serviceDateWindow(serviceDate);
    if (after > this.seq) after = 0;
    if (from < Date.now() - MEMORY_MS) {
      let cached = this.past.get(serviceDate);
      if (!cached) {
        cached = await readRecordedFixes(this.opts.recorder, serviceDate);
        this.past.set(serviceDate, cached);
        while (this.past.size > PAST_DATES_CACHED)
          this.past.delete(this.past.keys().next().value!);
      }
      return { fixes: after ? [] : cached, cursor: this.seq };
    }
    const fixes = this.fixes
      .filter((f) => f.seq > after && f.ts >= from && f.ts < to)
      .map(({ seq: _, ...f }) => f);
    return { fixes: fixes.sort((a, b) => a.ts - b.ts), cursor: this.seq };
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
    this.fixes.push({ ...fix, seq: ++this.seq });
    this.pending.push(fix);
  }

  /** Record pending fixes (an empty batch while connected keeps coverage going); prune memory. */
  private async flush(): Promise<void> {
    const now = Date.now();
    const batch = this.pending;
    this.pending = [];
    if (this.opts.record !== false && (batch.length || this.connected)) {
      await this.opts.recorder.record({
        fetchedAt: now,
        headerTs: now,
        vehicles: batch.map((f) => fixToVehicle(f, this.opts.route)),
      });
    }
    const cutoff = now - MEMORY_MS;
    if (this.fixes.length && this.fixes[0]!.ts < cutoff)
      this.fixes = this.fixes.filter((f) => f.ts >= cutoff);
  }
}

/** Recorded fixes that can belong to a service date's trips (see serviceDateWindow), sorted. */
export async function readRecordedFixes(
  recorder: Recorder,
  serviceDate: string,
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
