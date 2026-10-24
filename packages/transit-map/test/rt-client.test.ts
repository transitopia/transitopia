import { afterEach, describe, expect, it, vi } from "vitest";
import { parseConfig, parseFeed } from "@transitopia/transit-core/config.ts";
import type { LiveTransitResponse } from "@transitopia/transit-core/rt/live.ts";
import {
  compactSnapshot,
  type RtVehicle,
} from "@transitopia/transit-core/rt/types.ts";
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
