// Browser side of the live endpoint (packages/transit-core/src/rt/live.ts, apps/server/README.md#live-endpoint):
// while the clock is near now, one poll of GET /regions/<id>/live/transit serves buses, SeaBus AIS,
// service changes and live dispatch. It waits for the server's nextAt (within clientPollS and
// clientPollMaxS), and hands a response on only when it differs from the last one: the browser
// revalidates with the ETag, so an unchanged poll costs a 304.

import {
  LIVE_SCHEMA,
  type LiveTransitResponse,
} from "@transitopia/transit-core/rt/live.ts";
import type { RegionConfig } from "./config.ts";

/** Live mode applies when the clock is within this of wall-clock time. */
export const LIVE_WINDOW_MS = 10 * 60_000;

export interface LiveHandlers {
  /** A response that differs from the previous one (receivedAt: epoch ms). */
  onResponse(r: LiveTransitResponse, receivedAt: number): void;
  /** A poll failed; `missing` when there's no live endpoint at all (polling stops for good). */
  onError(error: string, missing: boolean): void;
  /** Polling stopped (the clock left the present): pointers in the last response may go stale. */
  onStop(): void;
}

export class LivePoller {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private last: string | undefined;
  private gone = false;
  /** Epoch ms of the last successful poll, changed or not. */
  lastOkAt = 0;
  private readonly url: string | undefined;
  private readonly cfg: RegionConfig["rt"];
  private readonly handlers: LiveHandlers;

  /** @param url the live endpoint, or undefined for schedules only. */
  constructor(
    url: string | undefined,
    cfg: RegionConfig["rt"],
    handlers: LiveHandlers,
  ) {
    this.url = url;
    this.cfg = cfg;
    this.handlers = handlers;
  }

  /** Called every frame with the clock time: polls while it's near now. */
  update(t: number): void {
    if (Math.abs(t - Date.now()) < LIVE_WINDOW_MS) this.start();
    else this.stop();
  }

  /** Whether a poll succeeded recently: live data is arriving. */
  get fresh(): boolean {
    return Date.now() - this.lastOkAt < 2 * this.cfg.clientPollMaxS * 1000;
  }

  private start(): void {
    if (this.timer !== undefined || !this.url || this.gone) return;
    this.timer = setTimeout(this.poll, 0);
  }

  stop(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    // Hand the next response on even if unchanged: readers may have dropped what this one said.
    this.last = undefined;
    this.handlers.onStop();
  }

  private poll = async (): Promise<void> => {
    let delayS = this.cfg.clientPollS;
    try {
      const res = await fetch(this.url!, { cache: "no-cache" });
      if (res.status === 404) {
        // No live endpoint (e.g. a server from before it, or a static build without one).
        this.gone = true;
        this.timer = undefined;
        this.handlers.onError("Real-time service not available", true);
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      const text = await res.text();
      this.lastOkAt = Date.now();
      const r = JSON.parse(text) as LiveTransitResponse;
      if (r.schema !== LIVE_SCHEMA)
        throw new Error(`schema ${String(r.schema)}`);
      if (text !== this.last) {
        this.last = text;
        this.handlers.onResponse(r, Date.now());
      }
      if (r.nextAt !== null)
        delayS = Math.min(
          this.cfg.clientPollMaxS,
          Math.max(
            this.cfg.clientPollS,
            (r.nextAt - Date.now()) / 1000 + this.cfg.clientPollSlackS,
          ),
        );
    } catch {
      this.last = undefined;
      this.handlers.onError("Real-time service unreachable", false);
    }
    if (this.timer !== undefined)
      this.timer = setTimeout(this.poll, delayS * 1000);
  };
}
