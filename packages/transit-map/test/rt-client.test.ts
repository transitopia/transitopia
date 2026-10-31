import { afterEach, describe, expect, it, vi } from "vitest";
import { parseConfig, parseFeed } from "@transitopia/transit-core/config.ts";
import type { LiveTransitResponse } from "@transitopia/transit-core/rt/live.ts";
import {
  compactSnapshot,
  encodeSnapshot,
  type RtVehicle,
} from "@transitopia/transit-core/rt/types.ts";
import {
  serviceDate,
  serviceDayStart,
  toWallTime,
} from "@transitopia/transit-core/time.ts";
import kinematics from "@transitopia/config/defaults/kinematics.json";
import rt from "@transitopia/config/defaults/rt.json";
import translink from "@transitopia/config/feeds/translink/feed.json";
import { RtClient } from "../src/rt.ts";

const config = {
  kinematics: parseConfig("kinematics", { ...kinematics, routes: {} }),
  rt: parseConfig("rt", rt),
  feed: parseFeed(translink),
};
const bus: RtVehicle = {
  id: "1",
  routeKey: "r",
  lat: 49.28,
  lon: -123.1,
  ts: 0,
};
const live = (
  fetchedAt: number,
  vehicles: RtVehicle[],
): LiveTransitResponse => ({
  schema: 1,
  nextAt: null,
  sources: {
    "translink/vehicles": {
      kind: "vehicles",
      encoding: "rt-snapshot/1",
      status: "ok",
      data: compactSnapshot({ fetchedAt, headerTs: fetchedAt, vehicles }),
    },
  },
});

describe("RtClient live span", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("falls back to schedule estimates while the feed answers without vehicles", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 404 })),
    );
    const client = new RtClient(
      {
        data: (p) => p,
        api: "https://api/",
        region: "https://api/regions/r/",
      },
      config,
    );
    const now = Date.now();
    client.acceptLive(live(now - 5_000, []), now);
    expect(client.vehiclesAt(now, undefined).mode).toBe("estimated");
    client.acceptLive(live(now - 1_000, [{ ...bus, ts: now - 1_000 }]), now);
    expect(client.vehiclesAt(now, undefined).mode).toBe("live");
  });
});

describe("RtClient recorded hours", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const day0 = serviceDayStart(serviceDate("20261020"));
  const day: [number, number] = [day0, day0 + 24 * 3600_000];
  const hourId = (t: number) => {
    const w = toWallTime(t);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${w.year}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}`;
  };
  const at = (hour: number) => day0 + hour * 3600_000 + 30 * 60_000;

  /** A client over a fully recorded day: the hours requested, and which to fail once. */
  async function setup(failOnce = new Set<string>()) {
    const requested: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = new URL(url);
        if (u.pathname === "/rt/coverage")
          return Response.json({
            intervals: [[day[0] - 3600_000, day[1] + 3600_000]],
          });
        if (u.pathname !== "/rt/history")
          return new Response("", { status: 404 });
        const key = `${u.searchParams.get("date")}T${u.searchParams.get("hour")}`;
        requested.push(key);
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 0));
        inFlight--;
        if (failOnce.delete(key)) return new Response("", { status: 500 });
        const date = u.searchParams.get("date")!;
        const start =
          serviceDayStart(serviceDate(date.replaceAll("-", "")))
          + Number(u.searchParams.get("hour")) * 3600_000;
        const line = (t: number) =>
          encodeSnapshot({
            fetchedAt: t,
            headerTs: t,
            vehicles: [{ ...bus, ts: t }],
          });
        return new Response(
          [0, 1, 2, 3].map((q) => line(start + q * 15 * 60_000)).join("\n"),
        );
      }),
    );
    const client = new RtClient(
      { data: (p) => p, api: "https://api/", region: "https://api/regions/r/" },
      config,
    );
    client.coverageFor(day[0], day[1]);
    await flush();
    return {
      client,
      requested,
      maxInFlight: () => maxInFlight,
      /** The mode at t straight after seeking there, and once loads have finished. */
      show: async (t: number, d = day) => {
        client.update(t, d);
        const first = client.vehiclesAt(t, undefined).mode;
        await flush();
        return [first, client.vehiclesAt(t, undefined).mode];
      },
    };
  }
  const flush = () => new Promise((r) => setTimeout(r, 5));

  it("keeps every hour of the day once loaded", async () => {
    const { requested, show } = await setup();
    for (let h = 4; h < 20; h++)
      expect(await show(at(h))).toEqual(["loading", "recorded"]);
    const loaded = requested.length;
    for (let h = 19; h >= 4; h--)
      expect(await show(at(h))).toEqual(["recorded", "recorded"]);
    expect(requested.length).toBe(loaded);
  });

  it("prefetches the whole day once scrubbed, each hour once", async () => {
    const { client, requested, show, maxInFlight } = await setup();
    await show(at(12));
    client.prefetchDay();
    for (let i = 0; i < 40; i++) await show(at(12));
    expect(new Set(requested).size).toBe(24);
    expect(requested.length).toBe(24);
    // The hour shown plus MAX_HOUR_LOADS.
    expect(maxInFlight()).toBeLessThanOrEqual(3);
    for (let h = 0; h < 24; h++)
      expect((await show(at(h)))[0]).toBe("recorded");
  });

  it("drops the hours of another day", async () => {
    const { requested, show } = await setup();
    await show(at(12));
    const next: [number, number] = [day[1], day[1] + 24 * 3600_000];
    await show(next[0] + 12.5 * 3600_000, next);
    const before = requested.length;
    expect(await show(at(12))).toEqual(["loading", "recorded"]);
    expect(requested.length).toBe(before + 1);
  });

  it("retries an hour that failed to load", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(day[1] + 7 * 24 * 3600_000);
    const t = at(9);
    const id = hourId(t);
    const { requested, show } = await setup(new Set([id]));
    await show(t);
    // Schedule estimates until the retry.
    expect(await show(t)).toEqual(["loading", "loading"]);
    expect(requested).toEqual([id]);
    vi.setSystemTime(Date.now() + 60_000);
    expect(await show(t)).toEqual(["loading", "recorded"]);
    expect(requested).toEqual([id, id]);
  });
});
