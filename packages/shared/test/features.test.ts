import { describe, expect, it } from "vitest";
import {
  modeOfKey,
  formatKey,
  isFeatureId,
  kindOfId,
  mintId,
  nameSuffix,
  parseKey,
  slugifyName,
} from "../src/features.ts";

describe("parseKey", () => {
  it("reads IDs, with or without a name suffix", () => {
    expect(parseKey("sn-k3v9qd7m")).toEqual({
      form: "id",
      id: "sn-k3v9qd7m",
      kind: "station",
      suffix: "",
    });
    expect(parseKey("sn-k3v9qd7m-waterfront")).toMatchObject({
      id: "sn-k3v9qd7m",
      suffix: "waterfront",
    });
    expect(parseKey("rt-4m2k8x0q-expo-line")).toMatchObject({
      kind: "route",
      suffix: "expo-line",
    });
  });

  it("refuses strings that aren't IDs", () => {
    // Unknown or reserved prefix, a letter not in Crockford base32, the wrong length, upper case.
    for (const s of [
      "zz-k3v9qd7m",
      "ph-k3v9qd7m",
      "sn-k3v9qd7l",
      "sn-k3v9qd7",
      "SN-K3V9QD7M",
      "sn-k3v9qd7m-",
      "",
    ])
      expect(parseKey(s), s).toBeUndefined();
  });

  it("reads refs, whose value may hold colons", () => {
    expect(parseKey("gtfs-stop:translink:12034")).toEqual({
      form: "ref",
      scheme: "gtfs-stop",
      namespace: "translink",
      value: "12034",
    });
    expect(parseKey("osm-way:123890")).toEqual({
      form: "ref",
      scheme: "osm-way",
      namespace: "",
      value: "123890",
    });
    expect(parseKey("gtfs-route:bc-transit-victoria:a:b/c")).toMatchObject({
      namespace: "bc-transit-victoria",
      value: "a:b/c",
    });
    expect(parseKey("run:expo-005")).toMatchObject({
      scheme: "run",
      value: "expo-005",
    });
  });

  it("refuses unknown schemes and a missing namespace (the old ?place= forms)", () => {
    for (const s of [
      "station:12034",
      "exchange:ubc-exchange",
      "stop:12034",
      "route:99",
      "gtfs-stop:12034",
      "osm-way:",
    ])
      expect(parseKey(s), s).toBeUndefined();
  });

  it("formats what it parses", () => {
    for (const s of [
      "sn-k3v9qd7m",
      "sn-k3v9qd7m-waterfront",
      "stop:translink:50123",
      "osm-node:42",
    ])
      expect(formatKey(parseKey(s)!)).toBe(s);
  });
});

describe("mintId", () => {
  it("mints IDs of the kind's prefix that parse back", () => {
    let n = 0;
    const random = (b: Uint8Array) => b.map(() => n++);
    const id = mintId("exchange", random);
    expect(id).toBe("ex-01234567");
    expect(isFeatureId(id)).toBe(true);
    expect(kindOfId(mintId("stop", random))).toBe("stop");
    expect(isFeatureId(`${id}-ubc`)).toBe(false);
  });
});

describe("name suffixes", () => {
  it("slugify names", () => {
    expect(slugifyName("Commercial–Broadway")).toBe("commercial-broadway");
    expect(slugifyName("Québec & 2nd")).toBe("quebec-and-2nd");
    expect(slugifyName("x".repeat(80))).toHaveLength(64);
  });

  it("drop a station's 'Station', and name stops by their code", () => {
    expect(nameSuffix("station", "Waterfront Station")).toBe("waterfront");
    expect(nameSuffix("stop", "Main St @ 1st Ave", { code: "50123" })).toBe(
      "50123",
    );
    expect(nameSuffix("stop", "Main St @ 1st Ave")).toBe("main-st-1st-ave");
    expect(nameSuffix("route", "R1")).toBe("r1");
  });
});

describe("modeOfKey", () => {
  const mode = (s: string) => modeOfKey(parseKey(s)!);

  it("sends cycling features to /cycling and the rest to /transit", () => {
    expect(mode("sn-k3v9qd7m-waterfront")).toBe("transit");
    expect(mode("vh-k3v9qd7m")).toBe("transit");
    expect(mode("run:expo-005")).toBe("transit");
    expect(mode("stop:translink:50123")).toBe("transit");
    expect(mode("cr-k3v9qd7m-seawall")).toBe("cycling");
    expect(mode("bp-k3v9qd7m")).toBe("cycling");
    expect(mode("gbfs-station:mobi:12")).toBe("cycling");
  });

  it("leaves OSM refs to the resolver", () => {
    expect(mode("osm-way:123")).toBeUndefined();
    expect(mode("osm-node:123")).toBeUndefined();
  });
});
