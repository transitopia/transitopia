import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONFIG_SCHEMAS,
  parseConfig,
  parseFeed,
  parseRegion,
  realtimeUrl,
  stripComments,
  type ConfigName,
} from "../src/config.ts";
import { DATASETS, realtimeOf } from "@transitopia/shared/datasets.ts";

const REGIONS = join(import.meta.dirname, "../../../regions");
const FEEDS = join(import.meta.dirname, "../../../feeds");
const dirs = (root: string) =>
  readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== "node_modules")
    .map((d) => d.name);
const readJson = (path: string): unknown =>
  JSON.parse(readFileSync(path, "utf8"));
const configFiles = dirs(REGIONS).flatMap((region) => {
  const dir = join(REGIONS, region, "config");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ region, name: f.replace(/\.json$/, ""), dir }));
});

const load = (name: ConfigName) =>
  JSON.parse(
    readFileSync(
      join(REGIONS, "metro-vancouver/config", `${name}.json`),
      "utf8",
    ),
  ) as Record<string, unknown>;

describe("region config", () => {
  it("finds the committed config files", () => {
    expect(configFiles.length).toBeGreaterThanOrEqual(10);
  });

  for (const { region, name, dir } of configFiles)
    it(`${region}/config/${name}.json matches its schema`, () => {
      expect(Object.keys(CONFIG_SCHEMAS)).toContain(name);
      const json: unknown = JSON.parse(
        readFileSync(join(dir, `${name}.json`), "utf8"),
      );
      expect(() => parseConfig(name as ConfigName, json)).not.toThrow();
    });

  it("drops comment keys at any depth", () => {
    expect(
      stripComments({ $c: 1, a: { $d: 2, b: [{ $e: 3, c: 4 }] } }),
    ).toEqual({ a: { b: [{ c: 4 }] } });
  });

  it("rejects a misspelled setting, naming the file and where", () => {
    const rt = load("rt");
    const { clientPollS, ...rest } = rt;
    expect(() =>
      parseConfig("rt", { ...rest, clientPollSecs: clientPollS }),
    ).toThrow(/Bad config rt\.json: .*clientPollS.*clientPollSecs/s);
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
    const k = load("kinematics");
    const routes = { ...(k["routes"] as object), expo: { lenght: 80 } };
    expect(() => parseConfig("kinematics", { ...k, routes })).toThrow(
      /routes\.expo/,
    );
  });
});

const translink = () =>
  readJson(join(FEEDS, "translink/feed.json")) as Record<string, unknown>;

describe("regions and feeds", () => {
  const regions = dirs(REGIONS).map((id) => ({
    id,
    region: parseRegion(readJson(join(REGIONS, id, "region.json"))),
  }));
  const feeds = dirs(FEEDS).map((id) => ({
    id,
    feed: parseFeed(readJson(join(FEEDS, id, "feed.json"))),
  }));

  it("finds them", () => {
    expect(regions.map((r) => r.id)).toContain("metro-vancouver");
    expect(feeds.map((f) => f.id)).toContain("translink");
  });

  for (const { id, feed } of feeds)
    it(`feeds/${id}: its id is its directory, and routes.json matches its schema`, () => {
      expect(feed.id).toBe(id);
      expect(() =>
        parseConfig("routes", readJson(join(FEEDS, id, "routes.json"))),
      ).not.toThrow();
    });

  for (const { id, region } of regions)
    it(`regions/${id}: its id is its directory, and it lists feeds that exist in its time zone`, () => {
      expect(region.id).toBe(id);
      for (const f of region.feeds) {
        const feed = feeds.find((x) => x.id === f)?.feed;
        expect(feed, f).toBeDefined();
        expect(feed!.timezone).toBe(region.timezone);
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
