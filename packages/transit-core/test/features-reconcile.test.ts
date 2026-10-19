import { describe, expect, it } from "vitest";
import {
  reconcile,
  routeName,
  type Decisions,
  type FeedRecords,
  type FeedStop,
  type GtfsFeatureKind,
  type RegistryFeature,
  type RegistryRef,
  type RegistrySnapshot,
} from "../src/features/reconcile.ts";

const settings = {
  stopNameMatchM: 50,
  stopMovedFarM: 300,
  disappearedNearM: 50,
  stationMatchM: 300,
  exchangeReplacedM: 250,
};

/** About 1 m of latitude, in degrees. */
const M = 1 / 111_195;

const stop = (
  id: string,
  name: string,
  lat: number,
  more: Partial<FeedStop> = {},
): FeedStop => ({
  id,
  name,
  lon: -123,
  lat: 49 + lat * M,
  station: false,
  nonBus: false,
  ...more,
});

/** The registry in memory, with the decisions applied as the server applies them. */
class Registry {
  features = new Map<string, RegistryFeature>();
  refs: (RegistryRef & { upper: number })[] = [];
  flags: Decisions["flags"] = [];
  private n = 0;
  private prev: number | undefined;

  snapshot(): RegistrySnapshot {
    const latest = new Map<string, RegistryRef>();
    for (const r of this.refs) {
      const k = `${r.scheme}\0${r.value}`;
      const l = latest.get(k);
      if (!l || r.upper > l.upper) latest.set(k, r);
    }
    // As loadSnapshot: a station's feeds are its refs' and the stops inside it.
    const feeds = (id: string) =>
      (
        this.refs.some((r) => r.featureId === id && r.scheme === "gtfs-stop")
        || [...this.features.values()].some(
          (f) => f.parentId === id && f.feedId === "f",
        )
      ) ?
        ["f"]
      : [];
    return {
      features: [...this.features.values()].map((f) =>
        f.kind === "station" ? { ...f, feeds: feeds(f.id) } : { ...f },
      ),
      refs: [...latest.values()].map((r) => ({ ...r })),
    };
  }

  run(seq: number, records: FeedRecords): Decisions {
    const d = reconcile({
      feed: "f",
      operator: "op",
      seq,
      prevSeq: this.prev,
      records,
      snapshot: this.snapshot(),
      settings,
      mint: (kind: GtfsFeatureKind) =>
        `${kind}-${String(++this.n).padStart(3, "0")}`,
    });
    for (const m of d.mint)
      this.features.set(m.id, {
        id: m.id,
        kind: m.kind,
        name: m.name,
        status: "active",
        ...(m.lon !== null ? { lon: m.lon, lat: m.lat! } : {}),
        ...(m.parentId ? { parentId: m.parentId } : {}),
        ...(m.feedId ? { feedId: m.feedId } : {}),
      });
    for (const id of d.reactivate) this.features.get(id)!.status = "active";
    for (const u of d.update) {
      const f = this.features.get(u.id)!;
      if (u.name !== undefined) f.name = u.name;
      if (u.lon !== undefined) Object.assign(f, { lon: u.lon, lat: u.lat });
    }
    for (const e of d.extendRefs)
      this.refs.find((r) => r.rowId === e.rowId)!.upper = e.upper;
    for (const r of d.insertRefs)
      this.refs.push({ ...r, rowId: this.refs.length + 1 });
    this.flags.push(...d.flags);
    this.prev = seq;
    return d;
  }

  /** The feature a ref names in a version. */
  at(scheme: string, value: string, seq: number): RegistryFeature | undefined {
    const r = this.refs.find(
      (r) =>
        r.scheme === scheme
        && r.value === value
        && r.lower <= seq
        && seq < r.upper,
    );
    return r && this.features.get(r.featureId);
  }
}

const base = (): FeedRecords => ({
  stops: [
    stop("99901", "Joyce-Collingwood Station", 0, { station: true }),
    stop("11001", "Joyce-Collingwood Station @ Platform 1", 5, {
      parent: "99901",
      nonBus: true,
    }),
    stop("11002", "Joyce-Collingwood Station @ Platform 2", 10, {
      parent: "99901",
      nonBus: true,
    }),
    stop("12001", "Joyce Station @ Bay 1", 60, { code: "50001" }),
    stop("13001", "UBC Exchange @ Bay 1", 5000, { code: "60001" }),
    stop("13002", "UBC Exchange @ Bay 2", 5030, { code: "60002" }),
    stop("14001", "Main St @ 1st Ave", 9000, { code: "70001" }),
  ],
  routes: [
    { id: "6612", shortName: "099", longName: "UBC/Commercial-Broadway" },
    { id: "30052", shortName: "", longName: "Expo Line" },
  ],
});

describe("reconcile", () => {
  it("mints every stop, station, exchange and route on a first run, with their parents", () => {
    const reg = new Registry();
    const d = reg.run(1, base());
    const kinds = d.mint.map((m) => m.kind).sort();
    expect(kinds).toEqual([
      "exchange",
      "route",
      "route",
      "station",
      "stop",
      "stop",
      "stop",
      "stop",
      "stop",
      "stop",
    ]);
    const station = reg.at("gtfs-stop", "99901", 1)!;
    expect(station).toMatchObject({
      kind: "station",
      name: "Joyce-Collingwood",
    });
    expect(reg.at("gtfs-stop", "11001", 1)!.parentId).toBe(station.id);
    // A bay beside a station is the station's.
    expect(reg.at("gtfs-stop", "12001", 1)!.parentId).toBe(station.id);
    const ubc = reg.at("gtfs-stop", "13001", 1)!.parentId!;
    expect(reg.features.get(ubc)).toMatchObject({
      kind: "exchange",
      name: "UBC Exchange",
    });
    expect(reg.at("stop", "60002", 1)!.parentId).toBe(ubc);
    expect(reg.at("gtfs-stop", "14001", 1)!.parentId).toBeUndefined();
    expect(reg.at("gtfs-route", "6612", 1)!.name).toBe("99");
    expect(reg.at("gtfs-route", "30052", 1)!.name).toBe("Expo Line");
    // Stations and exchanges come before the stops inside them.
    const order = d.mint.map((m) => m.id);
    expect(order.indexOf(ubc)).toBeLessThan(
      order.indexOf(reg.at("gtfs-stop", "13001", 1)!.id),
    );
    expect(reg.flags).toEqual([]);
  });

  it("carries every ref on into an unchanged version, and is idempotent", () => {
    const reg = new Registry();
    const first = reg.run(1, base());
    const d = reg.run(3, base());
    expect(d.mint).toEqual([]);
    expect(d.insertRefs).toEqual([]);
    expect(d.update).toEqual([]);
    expect(d.extendRefs).toHaveLength(first.insertRefs.length);
    expect(reg.refs.every((r) => r.lower === 1 && r.upper === 4)).toBe(true);
    const again = reg.run(3, base());
    expect(again).toEqual({
      mint: [],
      update: [],
      extendRefs: [],
      insertRefs: [],
      reactivate: [],
      flags: [],
    });
  });

  it("keeps a stop whose stop_id changed by its stop code", () => {
    const reg = new Registry();
    reg.run(1, base());
    const before = reg.at("gtfs-stop", "14001", 1)!;
    const v2 = base();
    v2.stops = v2.stops.map((s) =>
      s.id === "14001" ? { ...s, id: "14999", name: "Main St @ 1 Ave" } : s,
    );
    const d = reg.run(2, v2);
    expect(d.mint).toEqual([]);
    expect(reg.at("gtfs-stop", "14999", 2)).toBe(before);
    expect(before.name).toBe("Main St @ 1 Ave");
    // The old stop_id's range ends; the code's carries on.
    expect(reg.at("gtfs-stop", "14001", 2)).toBeUndefined();
    expect(reg.refs.find((r) => r.value === "70001")).toMatchObject({
      lower: 1,
      upper: 3,
    });
  });

  it("opens a new range when a ref comes back after a gap", () => {
    const reg = new Registry();
    reg.run(1, base());
    const f = reg.at("gtfs-stop", "14001", 1)!;
    const without = base();
    without.stops = without.stops.filter((s) => s.id !== "14001");
    reg.run(2, without);
    reg.run(3, base());
    expect(reg.at("gtfs-stop", "14001", 3)).toBe(f);
    expect(
      reg.refs
        .filter((r) => r.value === "14001")
        .map((r) => [r.lower, r.upper]),
    ).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it("puts a new bay in its exchange, or in none once an admin detached the others", () => {
    const reg = new Registry();
    reg.run(1, base());
    const ubc = reg.at("gtfs-stop", "13001", 1)!.parentId!;
    const v2 = base();
    v2.stops.push(
      stop("13003", "UBC Exchange @ Bay 3", 5060, { code: "60003" }),
    );
    expect(reg.run(2, v2).mint.map((m) => m.kind)).toEqual(["stop"]);
    expect(reg.at("gtfs-stop", "13003", 2)!.parentId).toBe(ubc);

    // Blanca Loop: an admin detaches its bays and retires the exchange.
    for (const id of ["13001", "13002", "13003"])
      delete reg.at("gtfs-stop", id, 2)!.parentId;
    reg.features.get(ubc)!.status = "retired";
    const v3 = structuredClone(v2);
    v3.stops.push(
      stop("13004", "UBC Exchange @ Bay 4", 5090, { code: "60004" }),
    );
    expect(reg.run(3, v3).mint.map((m) => m.kind)).toEqual(["stop"]);
    expect(reg.at("gtfs-stop", "13004", 3)!.parentId).toBeUndefined();
    expect(reg.flags).toEqual([]);
  });

  it("flags a new exchange beside one whose bays were all renumbered", () => {
    const reg = new Registry();
    reg.run(1, base());
    const ubc = reg.at("gtfs-stop", "13001", 1)!.parentId!;
    const v2 = base();
    v2.stops = v2.stops.map((s) =>
      s.code?.startsWith("6") ?
        { ...s, id: `x${s.id}`, code: `9${s.code}`, lat: s.lat + 10 * M }
      : s,
    );
    const d = reg.run(2, v2);
    const ex = d.mint.find((m) => m.kind === "exchange")!;
    expect(ex).toBeDefined();
    expect(reg.flags.filter((f) => f.reason === "exchange-replaced")).toEqual([
      expect.objectContaining({ featureId: ex.id, candidates: [ubc] }),
    ]);
    // Each renumbered bay is also beside the bay it replaced.
    expect(
      reg.flags.filter((f) => f.reason === "disappeared-nearby"),
    ).toHaveLength(2);
  });

  it("flags a stop code that moved far, and a new stop beside one that disappeared", () => {
    const reg = new Registry();
    reg.run(1, base());
    const main = reg.at("gtfs-stop", "14001", 1)!;
    const v2 = base();
    v2.stops = v2.stops.map((s) =>
      s.id === "14001" ? { ...s, lat: s.lat + 1000 * M } : s,
    );
    reg.run(2, v2);
    expect(reg.flags).toEqual([
      expect.objectContaining({ featureId: main.id, reason: "code-moved-far" }),
    ]);
    reg.flags = [];
    const v3 = base();
    v3.stops = v3.stops.map((s) =>
      s.id === "14001" ? { ...s, id: "15001", code: "80001" } : s,
    );
    const d = reg.run(3, v3);
    expect(d.mint.map((m) => m.kind)).toEqual(["stop"]);
    expect(reg.flags).toEqual([]);
  });

  it("merges a standalone rail stop into the station of the same name", () => {
    const reg = new Registry();
    const v = base();
    v.stops.push(
      stop("12138", "Joyce-Collingwood Station @ West Coast Express", 100, {
        code: "57893",
        nonBus: true,
      }),
    );
    reg.run(1, v);
    expect(reg.at("gtfs-stop", "12138", 1)!.parentId).toBe(
      reg.at("gtfs-stop", "99901", 1)!.id,
    );
  });

  it("keeps a station of standalone stops when their ids and codes change", () => {
    const reg = new Registry();
    const wce = (id: string, code: string, lat: number): FeedRecords => ({
      stops: [
        stop(id, "Mission City Station @ West Coast Express", lat, {
          code,
          nonBus: true,
        }),
      ],
      routes: [],
    });
    reg.run(1, wce("12500", "57900", 0));
    const station = reg.features.get(
      reg.at("gtfs-stop", "12500", 1)!.parentId!,
    )!;
    expect(station).toMatchObject({ kind: "station", name: "Mission City" });
    const d = reg.run(2, wce("13600", "58000", 20));
    expect(d.mint.map((m) => m.kind)).toEqual(["stop"]);
    expect(reg.at("gtfs-stop", "13600", 2)!.parentId).toBe(station.id);
    expect(reg.flags.map((f) => f.reason)).not.toContain(
      "cross-feed-name-match",
    );
  });

  it("reactivates a retired stop whose stop_id comes back, and flags it", () => {
    const reg = new Registry();
    reg.run(1, base());
    const main = reg.at("gtfs-stop", "14001", 1)!;
    const without = base();
    without.stops = without.stops.filter((s) => s.id !== "14001");
    reg.run(2, without);
    // An admin retires the stop that disappeared.
    main.status = "retired";
    const d = reg.run(3, base());
    expect(d.mint).toEqual([]);
    expect(d.reactivate).toEqual([main.id]);
    expect(reg.at("gtfs-stop", "14001", 3)).toBe(main);
    expect(main.status).toBe("active");
    expect(reg.flags).toEqual([
      expect.objectContaining({
        featureId: main.id,
        reason: "retired-returned",
      }),
    ]);
  });

  it("keeps a route by its name when its route_id changes", () => {
    const reg = new Registry();
    reg.run(1, base());
    const r = reg.at("gtfs-route", "6612", 1)!;
    const v2 = base();
    v2.routes[0] = { ...v2.routes[0]!, id: "7000" };
    expect(reg.run(2, v2).mint).toEqual([]);
    expect(reg.at("gtfs-route", "7000", 2)).toBe(r);
  });
});

describe("routeName", () => {
  it("drops leading zeros and falls back to the long name", () => {
    expect(routeName({ id: "1", shortName: "099", longName: "" })).toBe("99");
    expect(routeName({ id: "1", shortName: "R1", longName: "" })).toBe("R1");
    expect(routeName({ id: "1", shortName: "", longName: "Expo Line" })).toBe(
      "Expo Line",
    );
  });
});
