import { afterEach, describe, expect, it, vi } from "vitest";
import { serviceDate } from "@transitopia/transit-core/time.ts";
import { parseConfig, parseFeed } from "@transitopia/transit-core/config.ts";
import {
  encodeFixes,
  serviceDateWindow,
  type AisDayResponse,
} from "@transitopia/transit-core/ais/fixes.ts";
import type { AisFix } from "@transitopia/transit-core/ais/match.ts";
import type { LiveTransitResponse } from "@transitopia/transit-core/rt/live.ts";
import { preparePlan } from "@transitopia/transit-core/schedule/engine.ts";
import type { ServicePlan } from "@transitopia/transit-core/plan/types.ts";
import kinematics from "@transitopia/config/defaults/kinematics.json";
import rt from "@transitopia/config/defaults/rt.json";
import translink from "@transitopia/config/feeds/translink/feed.json";
import { AisClient } from "../src/ais.ts";

const config = {
  rt: parseConfig("rt", rt),
  feed: parseFeed(translink),
};
const plan: ServicePlan = {
  schema: 1,
  feed: "translink",
  feedVersion: "test",
  feedStart: serviceDate("20260901"),
  feedEnd: serviceDate("20261231"),
  timezone: "America/Vancouver",
  builtAt: "",
  routes: [],
  stops: [],
  stations: [],
  hubs: [],
  shapes: {},
  patterns: [],
  trips: [],
  calendar: { calendar: [], exceptions: [] },
};
const pp = preparePlan(
  plan,
  parseConfig("kinematics", { ...kinematics, routes: {} }),
);
const DATE = serviceDate("20261014");
const [start] = serviceDateWindow(DATE);
const fix = (ts: number): AisFix => ({
  mmsi: "316042365",
  ts,
  lat: 49.29,
  lon: -123.1,
});
const day = (fixes: AisFix[], to: number): AisDayResponse => ({
  status: "ok",
  to,
  complete: false,
  fixes: encodeFixes(fixes),
});
const live = (
  fixes: AisFix[],
  from: number,
  to: number,
): LiveTransitResponse => ({
  schema: 1,
  nextAt: null,
  sources: {
    "translink/ais": {
      kind: "ais",
      encoding: "ais-fixes/1",
      route: "seabus",
      status: "ok",
      from,
      to,
      data: encodeFixes(fixes),
    },
  },
});

describe("AisClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("continues the day file with live windows, and refetches it after a gap", async () => {
    const t0 = start + 3_600_000;
    const urls: string[] = [];
    let next = day([fix(t0 - 60_000)], t0);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        return new Response(JSON.stringify(next));
      }),
    );
    const client = new AisClient("https://api/regions/r/", config, () => true);
    const state = () => (client as any).dates.get(DATE);

    client.pairFor(DATE, pp);
    expect(urls).toEqual(["https://api/regions/r/days/20261014/translink/ais"]);
    await vi.waitFor(() => expect(state().loading).toBe(false));
    expect(state().fixes).toHaveLength(1);
    expect(state().syncedTo).toBe(t0);

    // A window reaching back past what the day file had continues it: no refetch.
    client.acceptLive(live([fix(t0 + 5_000)], t0 - 300_000, t0 + 10_000));
    client.pairFor(DATE, pp);
    expect(urls).toHaveLength(1);
    expect(state().fixes).toHaveLength(2);
    expect(state().syncedTo).toBe(t0 + 10_000);

    // A window starting after it (the tab slept) leaves a gap: the day file fills it.
    next = day(
      [fix(t0 - 60_000), fix(t0 + 5_000), fix(t0 + 400_000)],
      t0 + 700_000,
    );
    client.acceptLive(live([fix(t0 + 900_000)], t0 + 600_000, t0 + 900_000));
    expect(state().gap).toBe(true);
    client.pairFor(DATE, pp);
    expect(urls).toHaveLength(2);
    await vi.waitFor(() => expect(state().loading).toBe(false));
    expect(state().fixes.map((f: AisFix) => f.ts - t0)).toEqual([
      -60_000, 5_000, 400_000, 900_000,
    ]);
    expect(state().syncedTo).toBe(t0 + 700_000);
    expect(state().gap).toBe(false);
  });

  it("refreshes the day file without live data, and stops once it's complete", async () => {
    let fresh = false;
    const urls: string[] = [];
    let body: AisDayResponse = day([], start);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        return new Response(JSON.stringify(body));
      }),
    );
    const client = new AisClient("https://api/regions/r/", config, () => fresh);
    const state = () => (client as any).dates.get(DATE);
    client.pairFor(DATE, pp);
    await vi.waitFor(() => expect(state().loading).toBe(false));
    // Live data arriving: no refresh even when the last fetch is old.
    fresh = true;
    state().fetchedAt = 1;
    client.pairFor(DATE, pp);
    expect(urls).toHaveLength(1);
    // None: refresh.
    fresh = false;
    body = { ...day([], start), complete: true };
    client.pairFor(DATE, pp);
    expect(urls).toHaveLength(2);
    await vi.waitFor(() => expect(state().complete).toBe(true));
    state().fetchedAt = 1;
    client.pairFor(DATE, pp);
    expect(urls).toHaveLength(2);
  });
});
