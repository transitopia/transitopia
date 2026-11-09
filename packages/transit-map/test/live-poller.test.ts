import { afterEach, describe, expect, it, vi } from "vitest";
import { LivePoller } from "../src/live.ts";
import type { FeedConfig } from "../src/config.ts";

const cfg = {
  clientPollS: 10,
  clientPollMaxS: 60,
  clientPollSlackS: 3,
} as FeedConfig["rt"];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LivePoller", () => {
  it("polls at once when asked (the page is visible again), without starting a second loop", async () => {
    let release: (() => void) | undefined;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = () =>
            resolve(
              new Response(
                JSON.stringify({ schema: 1, nextAt: null, sources: {} }),
              ),
            );
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const p = new LivePoller("https://api.test/feeds/x/live", cfg, {
      onResponse: () => {},
      onError: () => {},
      onStop: () => {},
    });
    // Not polling: nothing to do.
    p.pollNow();
    await new Promise((r) => setTimeout(r, 5));
    expect(fetch).toHaveBeenCalledTimes(0);

    p.update(Date.now());
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    // A poll is under way: it is the one.
    p.pollNow();
    await new Promise((r) => setTimeout(r, 5));
    expect(fetch).toHaveBeenCalledTimes(1);
    release!();
    await vi.waitFor(() => expect(p.lastOkAt).toBeGreaterThan(0));
    // Waiting for its timer (10 s): poll now instead.
    p.pollNow();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    release!();
    p.stop();
  });
});
