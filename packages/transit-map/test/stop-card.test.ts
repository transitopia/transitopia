import { describe, expect, it } from "vitest";
import { serviceDate } from "@transitopia/transit-core/time.ts";
import { parseConfig } from "@transitopia/transit-core/config.ts";
import { preparePlan } from "@transitopia/transit-core/schedule/engine.ts";
import type {
  PlanStop,
  ServicePlan,
} from "@transitopia/transit-core/plan/types.ts";
import kinematics from "@transitopia/config/defaults/kinematics.json";
import { stopCard } from "../src/places.ts";

const stop = (id: string, name: string, parent?: string): PlanStop => ({
  id,
  name,
  lon: -123.1,
  lat: 49.28,
  ...(parent ? { parent } : {}),
});
const plan: ServicePlan = {
  schema: 1,
  feed: "translink",
  feedVersion: "test",
  feedStart: serviceDate("20260901"),
  feedEnd: serviceDate("20261231"),
  timezone: "America/Vancouver",
  builtAt: "",
  routes: [],
  stops: [
    stop("11282", "Waterfront Station @ Platform 2", "99901"),
    stop("60001", "Waterfront Station @ Bay 1"),
    stop("60100", "UBC Exchange @ Bay 7"),
    stop("50051", "Westbound Davie St @ Jervis St"),
  ],
  stations: [
    { id: "99901", name: "Waterfront Station", lon: 0, lat: 0, routes: [] },
  ],
  hubs: [
    {
      id: "h1",
      name: "Waterfront",
      lon: 0,
      lat: 0,
      bays: ["60001"],
      routes: [],
      station: "99901",
    },
    {
      id: "h2",
      name: "UBC Exchange",
      lon: 0,
      lat: 0,
      bays: ["60100"],
      routes: [],
    },
  ],
  shapes: {},
  patterns: [],
  trips: [],
  calendar: { calendar: [], exceptions: [] },
};
const pp = preparePlan(
  plan,
  parseConfig("kinematics", { ...kinematics, routes: {} }),
);
const feed = "translink";

describe("stopCard", () => {
  it("opens a platform's station", () => {
    for (const grouped of [false, true])
      expect(stopCard(pp, "11282", grouped)).toEqual({
        kind: "station",
        feed,
        id: "99901",
      });
  });

  it("opens a bus bay's own card, or grouped, its station's or exchange's", () => {
    expect(stopCard(pp, "60100", false)).toEqual({
      kind: "stop",
      feed,
      id: "60100",
    });
    expect(stopCard(pp, "60100", true)).toEqual({
      kind: "exchange",
      feed,
      id: "h2",
    });
    expect(stopCard(pp, "60001", true)).toEqual({
      kind: "station",
      feed,
      id: "99901",
    });
  });

  it("opens a street stop's card", () => {
    expect(stopCard(pp, "50051", true)).toEqual({
      kind: "stop",
      feed,
      id: "50051",
    });
  });
});
