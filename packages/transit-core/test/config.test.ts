import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONFIG_SCHEMAS,
  parseConfig,
  parseFeed,
  parseNetwork,
  parseOperator,
  parseRegion,
  realtimeUrl,
  resolveKinematics,
  resolveRt,
  stripComments,
  type ConfigName,
} from "../src/config.ts";
import { DATASETS, realtimeOf } from "@transitopia/shared/datasets.ts";

const CONFIG = join(import.meta.dirname, "../../../config");
const REGIONS = join(CONFIG, "regions");
const NETWORKS = join(CONFIG, "networks");
const FEEDS = join(CONFIG, "feeds");
const OPERATORS = join(CONFIG, "operators");
const DEFAULTS = join(CONFIG, "defaults");
const SERVER = join(CONFIG, "server");
const dirs = (root: string) =>
  readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== "node_modules")
    .map((d) => d.name);
const readJson = (path: string): unknown =>
  JSON.parse(readFileSync(path, "utf8"));
/** Each rail network's settings files (all but network.json). */
const settingsFiles = dirs(NETWORKS).flatMap((network) =>
  readdirSync(join(NETWORKS, network))
    .filter((f) => f.endsWith(".json") && f !== "network.json")
    .map((f) => ({ network, name: f.replace(/\.json$/, "") })),
);
const load = (name: string) =>
  readJson(join(NETWORKS, "skytrain", `${name}.json`)) as Record<
    string,
    unknown
  >;
const defaults = (name: string) =>
  readJson(join(DEFAULTS, `${name}.json`)) as Record<string, unknown>;
const operator = (id: string) =>
  parseOperator(readJson(join(OPERATORS, id, "operator.json")));

describe("config files", () => {
  it("finds the committed settings files", () => {
    expect(settingsFiles.length).toBeGreaterThanOrEqual(2);
  });

  for (const name of ["server", "recording"] as const)
    it(`server/${name}.json matches its schema`, () => {
      expect(() =>
        parseConfig(name, readJson(join(SERVER, `${name}.json`))),
      ).not.toThrow();
    });

  it("cycling/cycling.json matches its schema", () => {
    expect(() =>
      parseConfig("cycling", readJson(join(CONFIG, "cycling", "cycling.json"))),
    ).not.toThrow();
  });

  for (const { network, name } of settingsFiles)
    it(`networks/${network}/${name}.json matches its schema`, () => {
      const json = readJson(join(NETWORKS, network, `${name}.json`));
      expect(Object.keys(CONFIG_SCHEMAS)).toContain(name);
      expect(() => parseConfig(name as ConfigName, json)).not.toThrow();
    });

  for (const feed of dirs(FEEDS))
    for (const name of existsSync(join(FEEDS, feed, "ferries")) ?
      readdirSync(join(FEEDS, feed, "ferries"))
    : [])
      it(`feeds/${feed}/ferries/${name} matches its schema`, () => {
        const ferry = parseConfig(
          "ferry",
          readJson(join(FEEDS, feed, "ferries", name)),
        );
        expect(`${ferry.route}.json`).toBe(name);
      });

  for (const id of dirs(OPERATORS))
    it(`operators/${id}: its id is its directory`, () => {
      expect(operator(id).id).toBe(id);
    });

  it("drops comment keys at any depth", () => {
    expect(
      stripComments({ $c: 1, a: { $d: 2, b: [{ $e: 3, c: 4 }] } }),
    ).toEqual({ a: { b: [{ c: 4 }] } });
  });

  it("rejects a misspelled setting in any layer, naming where", () => {
    const op = operator("translink");
    expect(() =>
      resolveRt(defaults("rt"), op, {
        rt: { clientPollSecs: 5 },
      } as never),
    ).toThrow(/Bad config rt\.json: .*clientPollSecs/s);
    expect(() =>
      parseOperator({ id: "x", name: "X", rt: { carry: { maxTrip: 1 } } }),
    ).toThrow(/rt\.carry/);
    // The server's own settings are config/server/'s.
    expect(() =>
      parseOperator({ id: "x", name: "X", rt: { serverPort: 8787 } }),
    ).toThrow(/serverPort/);
  });

  it("rejects a setting of the wrong type", () => {
    const d = load("dispatch");
    expect(() => parseConfig("dispatch", { ...d, maxWaitS: "900" })).toThrow(
      /maxWaitS/,
    );
  });

  it("rejects poll bands out of order", () => {
    const feed = translink();
    const realtime = feed["realtime"] as Record<string, unknown>;
    const poll = realtime["poll"] as { weekday: { from: string }[] };
    const weekday = [...poll.weekday].reverse();
    expect(() =>
      parseFeed({
        ...feed,
        realtime: { ...realtime, poll: { ...poll, weekday } },
      }),
    ).toThrow(/Bad feed\.json: realtime\.poll\.weekday/);
  });

  it("rejects a per-route kinematics override that isn't a setting", () => {
    const routes = readJson(join(FEEDS, "translink", "routes.json")) as {
      routes: Record<string, unknown>[];
    };
    const [expo, ...rest] = routes.routes;
    expect(() =>
      parseConfig("routes", {
        routes: [{ ...expo, kinematics: { lenght: 80 } }, ...rest],
      }),
    ).toThrow(/routes\.0\.kinematics/);
  });

  it("lays operator, feed and route settings over the defaults", () => {
    const routes = parseConfig(
      "routes",
      readJson(join(FEEDS, "translink", "routes.json")),
    ).routes;
    const k = resolveKinematics(
      defaults("kinematics"),
      operator("translink"),
      {},
      routes,
    );
    // TransLink's drawn buses are articulated; BC Transit's the default 12 m.
    expect(k.modes["bus"]!.length).toBe(18);
    expect(k.modes["bus"]!.width).toBe(2.6);
    expect(k.routes["expo"]!.length).toBe(80);
    expect(
      resolveKinematics(defaults("kinematics"), operator("bc-transit"), {}, [])
        .modes["bus"]!.length,
    ).toBe(12);
    // A feed's overrides go over its operator's.
    expect(
      resolveKinematics(
        defaults("kinematics"),
        operator("translink"),
        { kinematics: { modes: { bus: { length: 12 } } } },
        [],
      ).modes["bus"]!.length,
    ).toBe(12);
    // Nested settings merge.
    const rt = resolveRt(defaults("rt"), operator("translink"), {
      rt: { clientPollS: 5, prediction: { binM: 25 } },
    });
    expect(rt.clientPollS).toBe(5);
    expect(rt.prediction.binM).toBe(25);
    expect(rt.prediction.stopZoneM).toBe(
      (defaults("rt")["prediction"] as { stopZoneM: number }).stopZoneM,
    );
  });
});

const translink = () =>
  readJson(join(FEEDS, "translink/feed.json")) as Record<string, unknown>;

describe("regions, feeds and rail networks", () => {
  const regions = dirs(REGIONS).map((id) => ({
    id,
    region: parseRegion(readJson(join(REGIONS, id, "region.json"))),
  }));
  const networks = dirs(NETWORKS).map((id) => ({
    id,
    network: parseNetwork(readJson(join(NETWORKS, id, "network.json"))),
  }));
  const feeds = dirs(FEEDS).map((id) => ({
    id,
    feed: parseFeed(readJson(join(FEEDS, id, "feed.json"))),
  }));

  it("finds them", () => {
    expect(regions.map((r) => r.id)).toContain("metro-vancouver");
    expect(feeds.map((f) => f.id)).toContain("translink");
    expect(networks.map((n) => n.id)).toContain("skytrain");
  });

  for (const { id, feed } of feeds)
    it(`feeds/${id}: its id is its directory, and routes.json matches its schema`, () => {
      expect(feed.id).toBe(id);
      expect(() =>
        parseConfig("routes", readJson(join(FEEDS, id, "routes.json"))),
      ).not.toThrow();
    });

  for (const { id, network } of networks)
    it(`networks/${id}: its id is its directory, and its feeds exist in its time zone with track-level routes`, () => {
      expect(network.id).toBe(id);
      for (const f of network.feeds) {
        const feed = feeds.find((x) => x.id === f)?.feed;
        expect(feed, f).toBeDefined();
        expect(feed!.timezone).toBe(network.timezone);
        const routes = parseConfig(
          "routes",
          readJson(join(FEEDS, f, "routes.json")),
        ).routes;
        expect(routes.some((r) => r.kind === "skytrain")).toBe(true);
      }
    });

  for (const { id, region } of regions)
    it(`regions/${id}: its id is its directory, and its feeds exist and resolve`, () => {
      expect(region.id).toBe(id);
      for (const f of region.feeds) {
        const feed = feeds.find((x) => x.id === f)?.feed;
        expect(feed, f).toBeDefined();
        // Every layer together: the defaults, the operator, the feed and the routes.
        const op = operator(feed!.operator);
        const routes = parseConfig(
          "routes",
          readJson(join(FEEDS, f, "routes.json")),
        ).routes;
        expect(() =>
          resolveKinematics(defaults("kinematics"), op, feed!, routes),
        ).not.toThrow();
        expect(() => resolveRt(defaults("rt"), op, feed!)).not.toThrow();
      }
    });

  it("feeds credit a registered dataset, with its real-time companion where they have real time", () => {
    for (const { id, feed } of feeds) {
      expect(DATASETS, id).toHaveProperty(feed.dataset);
      if (feed.realtime) expect(realtimeOf(feed.dataset), id).toBeDefined();
    }
  });

  it("regions don't overlap", () => {
    for (const a of regions)
      for (const b of regions) {
        if (a.id >= b.id) continue;
        const [aw, as, ae, an] = a.region.bbox;
        const [bw, bs, be, bn] = b.region.bbox;
        expect(
          aw < be && bw < ae && as < bn && bs < an,
          `${a.id} and ${b.id}`,
        ).toBe(false);
      }
  });

  it("fills in a key, and refuses URLs that don't agree with apiKey", () => {
    const rt = parseFeed(translink()).realtime!;
    expect(realtimeUrl(rt, "alerts", "k&y")).toBe(
      "https://gtfsapi.translink.ca/v3/gtfsalerts?apikey=k%26y",
    );
    expect(() => realtimeUrl(rt, "alerts", undefined)).toThrow(
      /no TRANSLINK_API_KEY/,
    );
    const { apiKey: _, ...keyless } = translink()["realtime"] as Record<
      string,
      unknown
    >;
    expect(() => parseFeed({ ...translink(), realtime: keyless })).toThrow(
      /apiKey/,
    );
  });
});
