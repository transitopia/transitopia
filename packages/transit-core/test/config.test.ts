import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONFIG_SCHEMAS,
  parseConfig,
  stripComments,
  type ConfigName,
} from "../src/config.ts";

const REGIONS = join(import.meta.dirname, "../../../regions");
const configFiles = readdirSync(REGIONS, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .flatMap((d) => {
    const dir = join(REGIONS, d.name, "config");
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => ({ region: d.name, name: f.replace(/\.json$/, ""), dir }));
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
    expect(configFiles.length).toBeGreaterThanOrEqual(7);
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
    const { staleGraceS, ...rest } = rt;
    expect(() =>
      parseConfig("rt", { ...rest, staleGraceSecs: staleGraceS }),
    ).toThrow(/Bad config rt\.json: .*staleGraceS.*staleGraceSecs/s);
  });

  it("rejects a setting of the wrong type", () => {
    const d = load("dispatch");
    expect(() => parseConfig("dispatch", { ...d, maxWaitS: "900" })).toThrow(
      /maxWaitS/,
    );
  });

  it("rejects poll bands out of order", () => {
    const rt = load("rt");
    const poll = rt["poll"] as { weekday: { from: string }[] };
    const weekday = [...poll.weekday].reverse();
    expect(() =>
      parseConfig("rt", { ...rt, poll: { ...poll, weekday } }),
    ).toThrow(/poll\.weekday/);
  });

  it("rejects a per-route kinematics override that isn't a setting", () => {
    const k = load("kinematics");
    const routes = { ...(k["routes"] as object), expo: { lenght: 80 } };
    expect(() => parseConfig("kinematics", { ...k, routes })).toThrow(
      /routes\.expo/,
    );
  });
});
