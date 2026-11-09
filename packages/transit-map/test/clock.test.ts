import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Clock } from "../src/clock.ts";

// The wall clock and performance.now() move independently: performance.now() stops while the
// device sleeps (issue #181).
let wall = 0;
let perf = 0;
const advance = (ms: number) => {
  wall += ms;
  perf += ms;
};
const sleep = (ms: number) => {
  wall += ms;
};

beforeEach(() => {
  wall = Date.UTC(2026, 10, 8, 18, 0, 0);
  perf = 1000;
  vi.spyOn(Date, "now").mockImplementation(() => wall);
  vi.spyOn(performance, "now").mockImplementation(() => perf);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Clock", () => {
  it("starts live without a time, and stays live through a sleep", () => {
    const c = new Clock();
    expect(c.isLive()).toBe(true);
    advance(2000);
    expect(c.now()).toBe(wall);
    sleep(30 * 60_000);
    expect(c.now()).toBe(wall);
    expect(c.isLive()).toBe(true);
  });

  it("keeps a paused clock, or one at another time or rate, where it was through a sleep", () => {
    const paused = new Clock();
    paused.pause();
    const at = paused.now();
    sleep(30 * 60_000);
    expect(paused.now()).toBe(at);
    expect(paused.isLive()).toBe(false);

    const past = new Clock(wall - 3_600_000);
    advance(1000);
    sleep(30 * 60_000);
    expect(past.now()).toBe(wall - 3_600_000 - 30 * 60_000);
    expect(past.isLive()).toBe(false);

    const fast = new Clock();
    fast.setRate(10);
    expect(fast.isLive()).toBe(false);
    advance(1000);
    sleep(60_000);
    expect(fast.now()).toBe(wall - 60_000 + 9000);
  });

  it("stops being live when seeking, changing rate or pausing; goLive() resumes it", () => {
    const c = new Clock();
    c.seek(wall - 600_000);
    expect(c.isLive()).toBe(false);
    c.goLive();
    expect(c.isLive()).toBe(true);
    c.setRate(-1);
    expect(c.isLive()).toBe(false);
    c.goLive();
    c.pause();
    expect(c.isLive()).toBe(false);
    c.goLive();
    sleep(60_000);
    expect(c.now()).toBe(wall);
  });

  it("counts catching up with the present at 1× as live", () => {
    const c = new Clock(wall - 60_000);
    c.setRate(10);
    advance(6_000); // 60 s behind + 6 s × 10 = 6 s ahead
    expect(c.isLive()).toBe(false);
    c.setRate(1);
    expect(c.isLive()).toBe(false); // 6 s ahead
    c.seek(wall + 2000);
    expect(c.isLive()).toBe(true);
    // ... and from then on follows the wall clock.
    sleep(60_000);
    expect(c.now()).toBe(wall);
  });

  it("stops at the end of the timetables, live or not", () => {
    const c = new Clock();
    c.setBounds(wall - 3_600_000, wall + 60_000);
    sleep(120_000);
    expect(c.now()).toBe(wall - 60_000);
    expect(c.playing).toBe(false);
    expect(c.isLive()).toBe(false);
  });
});
