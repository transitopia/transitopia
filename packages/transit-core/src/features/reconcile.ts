// Feature reconciliation (docs/DESIGN.md#feature-ids, apps/server/README.md#feature-reconciliation):
// which feature each stop, station and route of a GTFS feed version belongs to, which are new, and
// which station or exchange a new stop belongs to. Pure: (registry snapshot, the feed's stops and
// routes, settings) → decisions, which the server applies. It never blocks: a doubtful case is
// minted as a new feature and flagged for an admin, who can merge it afterwards.
//
// Containment is the registry's (docs/DESIGN.md#relationships-between-features): the station and
// bay heuristics only propose a parent for a stop when it's first minted, and an existing stop's
// parent is never changed here, even when it has none.
//
// A stop several feeds serve is one feature (docs/DESIGN.md#shared-stops): a new stop that's another
// feed's stop (`sharedStopMatch`) takes that feature, and `sharedStopMerges` finds the pairs minted
// apart before, for the server to merge.

import type { Config } from "../config.ts";
import { distM, type LonLat } from "../geo.ts";
import { baseName, bayNumber, groupBays, isBay } from "../plan/exchanges.ts";
import { groupStations, stationName } from "../plan/stations.ts";

export type ReconcileSettings = Config<"reconcile">;

/** The kinds reconciliation deals with. */
export type GtfsFeatureKind = "station" | "exchange" | "stop" | "route";
/** The ref schemes it writes: GTFS ids and stop codes, which hold over ranges of feed versions. */
export type GtfsScheme = "gtfs-stop" | "gtfs-route" | "stop";

/** A stops.txt row. Entrances, generic nodes and boarding areas (location_type 2–4) are left out. */
export interface FeedStop {
  id: string;
  /** stop_code: the number on the sign. */
  code?: string | undefined;
  name: string;
  lon: number;
  lat: number;
  /** 1: a parent station; 0: a stop or platform. */
  station: boolean;
  /** parent_station. */
  parent?: string | undefined;
  /** Whether a rail or ferry trip (route_type ≠ 3) calls here. */
  nonBus: boolean;
}

/** A routes.txt row. */
export interface FeedRoute {
  id: string;
  shortName: string;
  longName: string;
}

/** What reconciliation reads from one feed version: every stop and route, not only the plan's. */
export interface FeedRecords {
  stops: FeedStop[];
  routes: FeedRoute[];
}

export interface RegistryFeature {
  id: string;
  kind: GtfsFeatureKind;
  name: string;
  lon?: number | undefined;
  lat?: number | undefined;
  parentId?: string | undefined;
  status: "active" | "retired" | "merged";
  /**
   * The feed a route comes from, and a stop's home feed: the one it was first minted from, whose
   * versions set its name and position (a stop other feeds share has their refs too). For an
   * exchange, the feed most of its stops are from, which likewise sets its name and position.
   */
  feedId?: string | undefined;
  /** For stations: the feeds of their gtfs-stop refs. */
  feeds?: string[] | undefined;
  /** An admin set its name or position (feature_changes), so they aren't refreshed from GTFS. */
  nameLocked?: boolean | undefined;
  geomLocked?: boolean | undefined;
}

/** A ref's newest range of versions (gtfs_feeds.seq): [lower, upper). */
export interface RegistryRef {
  rowId: number;
  featureId: string;
  scheme: GtfsScheme;
  value: string;
  lower: number;
  upper: number;
}

export interface RegistrySnapshot {
  /**
   * This feed's stops (those it's the home feed of, and those with a ref in it) and routes, every
   * station and exchange, and the `shared` stops.
   */
  features: RegistryFeature[];
  /** The newest range of each of this feed's refs. */
  refs: RegistryRef[];
  /**
   * Other feeds' active stops, none with a gtfs-stop ref in this feed: those a new stop of this feed
   * may be (`sharedStopMatch`). Each is in `features` too.
   */
  shared: SharedStop[];
}

/**
 * A stop as shared-stop matching sees it (docs/DESIGN.md#shared-stops): where it is, its name, and
 * the feeds it's in (a gtfs-stop ref there) with their operators and its newest code in each.
 */
export interface SharedStop {
  id: string;
  name: string;
  lon: number;
  lat: number;
  feeds: { feed: string; operator: string; code?: string | undefined }[];
}

/** How two stops were found to be the same physical stop: by an operator's stop code, or nearness. */
export type SharedMatch = "code" | "near";

/**
 * Whether two stops of different feeds are the same physical stop (docs/DESIGN.md#shared-stops):
 * of the same operator, when they have the same stop code within `sharedStopCodeM` (its codes are
 * its own: two of its codes are two stops, however close); of different operators, when they're
 * within `sharedStopM` and aren't bays with different numbers. Never two stops of one feed.
 */
export function sharedStopMatch(
  a: SharedStop,
  b: SharedStop,
  settings: Pick<ReconcileSettings, "sharedStopCodeM" | "sharedStopM">,
): SharedMatch | undefined {
  if (a.feeds.some((x) => b.feeds.some((y) => y.feed === x.feed)))
    return undefined;
  const d = distM(at(a), at(b));
  const sameOperator = a.feeds.some((x) =>
    b.feeds.some((y) => y.operator === x.operator),
  );
  if (sameOperator)
    return (
        d < settings.sharedStopCodeM
          && a.feeds.some(
            (x) =>
              x.code !== undefined
              && b.feeds.some(
                (y) => y.operator === x.operator && y.code === x.code,
              ),
          )
      ) ?
        "code"
      : undefined;
  if (d >= settings.sharedStopM) return undefined;
  const na = bayNumber({ name: a.name });
  const nb = bayNumber({ name: b.name });
  return na !== undefined && nb !== undefined && na !== nb ? undefined : "near";
}

/** Metres in a degree of latitude, for the grid `sharedStopIndex` buckets stops in. */
const M_PER_DEG = 111_320;
/** The grid's cells are this much wider in longitude, so they're wide enough as far north as 70°. */
const LON_CELL_FACTOR = 3;

/** The stops that may match a stop (within the larger of the two distances), by a grid. */
function sharedStopIndex(
  stops: readonly SharedStop[],
  settings: Pick<ReconcileSettings, "sharedStopCodeM" | "sharedStopM">,
): (s: { lon: number; lat: number }) => SharedStop[] {
  const cell =
    Math.max(settings.sharedStopCodeM, settings.sharedStopM) / M_PER_DEG;
  const key = (x: number, y: number) => `${x},${y}`;
  const cx = (lon: number) => Math.floor(lon / (cell * LON_CELL_FACTOR));
  const cy = (lat: number) => Math.floor(lat / cell);
  const grid = new Map<string, SharedStop[]>();
  for (const s of stops) {
    const k = key(cx(s.lon), cy(s.lat));
    let l = grid.get(k);
    if (!l) grid.set(k, (l = []));
    l.push(s);
  }
  return (s) => {
    const out: SharedStop[] = [];
    const x = cx(s.lon);
    const y = cy(s.lat);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        out.push(...(grid.get(key(x + dx, y + dy)) ?? []));
    return out;
  };
}

/** The best match for a stop among candidates: by code before by nearness, then the nearest. */
function bestShared(
  s: SharedStop,
  candidates: readonly SharedStop[],
  settings: Pick<ReconcileSettings, "sharedStopCodeM" | "sharedStopM">,
): { stop: SharedStop; match: SharedMatch; m: number } | undefined {
  let best: { stop: SharedStop; match: SharedMatch; m: number } | undefined;
  for (const c of candidates) {
    const match = sharedStopMatch(s, c, settings);
    if (!match) continue;
    const m = distM(at(s), at(c));
    if (
      !best
      || (match === "code" && best.match === "near")
      || (match === best.match && m < best.m)
    )
      best = { stop: c, match, m };
  }
  return best;
}

/** An exchange as `sharedExchangeMerges` sees it. */
export interface SharedExchange {
  id: string;
  name: string;
  lon: number;
  lat: number;
  /** The feeds of the stops in it (their gtfs-stop refs'). */
  feeds: string[];
  /** How many active stops are in it. */
  stops: number;
}

/** A merge of one exchange into another of the same name, from other feeds' stops. */
export interface SharedExchangeMerge {
  from: string;
  into: string;
  m: number;
}

/**
 * Exchanges already in the registry that are one exchange several feeds' buses serve
 * (docs/DESIGN.md#shared-stops): of the same name within `exchangeMatchM`, with stops from different
 * feeds (two exchanges of one feed are the operator's to tell apart, and an admin's). Each group
 * merges into the exchange with the most stops, then the first by ID.
 */
export function sharedExchangeMerges(
  exchanges: readonly SharedExchange[],
  settings: Pick<ReconcileSettings, "exchangeMatchM">,
): SharedExchangeMerge[] {
  const order = [...exchanges]
    .filter((e) => e.feeds.length)
    .sort((a, b) => b.stops - a.stops || a.id.localeCompare(b.id));
  const out: SharedExchangeMerge[] = [];
  const taken = new Set<string>();
  for (const into of order) {
    if (taken.has(into.id)) continue;
    const feeds = new Set(into.feeds);
    for (const from of order) {
      if (from === into || taken.has(from.id)) continue;
      if (normalizeName(from.name) !== normalizeName(into.name)) continue;
      const m = distM(at(from), at(into));
      if (m >= settings.exchangeMatchM) continue;
      if (from.feeds.some((f) => feeds.has(f))) continue;
      for (const f of from.feeds) feeds.add(f);
      taken.add(from.id);
      out.push({ from: from.id, into: into.id, m: Math.round(m) });
    }
    taken.add(into.id);
  }
  return out;
}

/** A merge of one stop into another that's the same physical stop. */
export interface SharedStopMerge {
  from: string;
  into: string;
  match: SharedMatch;
  /** How far apart they are (m). */
  m: number;
}

/**
 * The stops already in the registry that are the same physical stop (docs/DESIGN.md#shared-stops),
 * as merges: pairs by code before pairs by nearness, nearest first, never joining two stops of one
 * feed. Each group merges into the stop listed first (the caller lists the oldest first).
 */
export function sharedStopMerges(
  stops: readonly SharedStop[],
  settings: Pick<ReconcileSettings, "sharedStopCodeM" | "sharedStopM">,
): SharedStopMerge[] {
  const order = new Map(stops.map((s, i) => [s.id, i]));
  const near = sharedStopIndex(stops, settings);
  const pairs: {
    a: SharedStop;
    b: SharedStop;
    match: SharedMatch;
    m: number;
  }[] = [];
  for (const a of stops)
    for (const b of near(a)) {
      if (order.get(b.id)! <= order.get(a.id)!) continue;
      const match = sharedStopMatch(a, b, settings);
      if (match) pairs.push({ a, b, match, m: distM(at(a), at(b)) });
    }
  pairs.sort(
    (x, y) =>
      Number(x.match === "near") - Number(y.match === "near") || x.m - y.m,
  );
  // Groups as union-find, each with its feeds: a group never takes in a second stop of a feed.
  const root = new Map<string, string>();
  const find = (id: string): string => {
    const r = root.get(id) ?? id;
    if (r === id) return id;
    const top = find(r);
    root.set(id, top);
    return top;
  };
  const feeds = new Map(
    stops.map((s) => [s.id, new Set(s.feeds.map((f) => f.feed))]),
  );
  const how = new Map<string, { match: SharedMatch; m: number }>();
  for (const { a, b, match, m } of pairs) {
    let ra = find(a.id);
    let rb = find(b.id);
    if (ra === rb) continue;
    const fa = feeds.get(ra)!;
    const fb = feeds.get(rb)!;
    if ([...fb].some((f) => fa.has(f))) continue;
    if (order.get(rb)! < order.get(ra)!) [ra, rb] = [rb, ra];
    root.set(rb, ra);
    for (const f of fb) feeds.get(ra)!.add(f);
    how.set(rb, { match, m });
  }
  const out: SharedStopMerge[] = [];
  for (const s of stops) {
    const into = find(s.id);
    if (into === s.id) continue;
    // How it joined: set when it stopped being its group's root.
    const h = how.get(s.id)!;
    out.push({ from: s.id, into, match: h.match, m: Math.round(h.m) });
  }
  return out;
}

export interface ReconcileInput {
  feed: string;
  operator: string;
  /** What the feed's routes are keyed by (feed.json → routeKey), and so matched by: name by default. */
  routeKey?: "name" | "route_id" | undefined;
  /** The version being reconciled (gtfs_feeds.seq). */
  seq: number;
  /** The feed's previous reconciled version, if any. */
  prevSeq?: number | undefined;
  records: FeedRecords;
  snapshot: RegistrySnapshot;
  settings: ReconcileSettings;
  /** A new ID of a kind, not used before (the caller checks every existing ID). */
  mint: (kind: GtfsFeatureKind) => string;
}

export interface NewFeature {
  id: string;
  kind: GtfsFeatureKind;
  name: string;
  /** Null for a route. */
  lon: number | null;
  lat: number | null;
  parentId: string | null;
  feedId: string | null;
  operatorId: string | null;
}

export interface FeatureUpdate {
  id: string;
  name?: string;
  lon?: number;
  lat?: number;
}

export type FlagReason =
  | "shared-stop"
  | "code-moved-far"
  | "disappeared-nearby"
  | "cross-feed-name-match"
  | "exchange-replaced"
  | "grouping-differs"
  | "retired-returned";

export interface Flag {
  featureId: string;
  reason: FlagReason;
  candidates: string[];
  detail: Record<string, unknown>;
}

export interface Decisions {
  /** In order: stations and exchanges before the stops inside them. */
  mint: NewFeature[];
  update: FeatureUpdate[];
  /** Newest ranges that carry on into this version: their new upper bound. */
  extendRefs: { rowId: number; upper: number }[];
  /** New ranges, starting at this version. */
  insertRefs: {
    featureId: string;
    scheme: GtfsScheme;
    value: string;
    lower: number;
    upper: number;
  }[];
  /**
   * Retired stops and stations whose stop_id or stop code came back in this version: active again
   * (retiring one means it's gone; the feed says it isn't), each flagged `retired-returned`.
   */
  reactivate: string[];
  flags: Flag[];
}

/** A name for comparison: accents, case, punctuation and spacing ignored, "&" as "and". */
export function normalizeName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * A route's name: its short name without leading zeros (TransLink's "099" → "99", "R1"), else its
 * long name ("Expo Line"). Routes are matched by it (CLAUDE.md: select routes by name).
 */
export function routeName(
  r: Pick<FeedRoute, "id" | "shortName" | "longName">,
): string {
  const short = r.shortName.trim().replace(/^0+(?=\d)/, "");
  return short || r.longName.trim() || r.id;
}

/** A name or position changing by less than this isn't an update (m). */
const MOVED_M = 0.5;

const at = (x: { lon: number; lat: number }): LonLat => [x.lon, x.lat];
const located = (
  f: RegistryFeature,
): f is RegistryFeature & { lon: number; lat: number } =>
  f.lon !== undefined && f.lat !== undefined;

/** The most common value, the first seen winning a tie. */
function majority<T>(values: readonly T[]): T | undefined {
  const n = new Map<T, number>();
  for (const v of values) n.set(v, (n.get(v) ?? 0) + 1);
  let best: T | undefined;
  let bestN = 0;
  for (const [v, c] of n)
    if (c > bestN) {
      best = v;
      bestN = c;
    }
  return best;
}

/** The feature closest to a point (those without a position last). */
function nearest<T extends RegistryFeature>(
  fs: readonly T[],
  p: LonLat,
): T | undefined {
  const d = (f: T) => (located(f) ? distM(at(f), p) : Infinity);
  return [...fs].sort((a, b) => d(a) - d(b))[0];
}

function centroid(xs: readonly { lon: number; lat: number }[]): LonLat {
  return [
    xs.reduce((s, x) => s + x.lon, 0) / xs.length,
    xs.reduce((s, x) => s + x.lat, 0) / xs.length,
  ];
}

/** Which feature each of a feed version's stops, stations and routes is, and what's new. */
export function reconcile(input: ReconcileInput): Decisions {
  const { feed, operator, seq, prevSeq, records, snapshot, settings } = input;
  const out: Decisions = {
    mint: [],
    update: [],
    extendRefs: [],
    insertRefs: [],
    reactivate: [],
    flags: [],
  };
  const features = new Map(snapshot.features.map((f) => [f.id, f]));
  const refKey = (scheme: GtfsScheme, value: string) => `${scheme}\0${value}`;
  const latest = new Map(
    snapshot.refs.map((r) => [refKey(r.scheme, r.value), r]),
  );
  const refFeature = (
    scheme: GtfsScheme,
    value: string,
    kind: GtfsFeatureKind,
  ) => {
    const r = latest.get(refKey(scheme, value));
    const f = r && features.get(r.featureId);
    return f && f.kind === kind && f.status !== "merged" ? f : undefined;
  };
  // Present in the previous version: the ref's newest range ends just after it.
  const inPrevious = (r: RegistryRef) =>
    prevSeq !== undefined && r.upper === prevSeq + 1;
  // A stop's code: its newest stop ref.
  const codeOf = new Map<string, { code: string; upper: number }>();
  for (const r of snapshot.refs)
    if (r.scheme === "stop") {
      const c = codeOf.get(r.featureId);
      if (!c || r.upper > c.upper)
        codeOf.set(r.featureId, { code: r.value, upper: r.upper });
    }

  const emitted = new Set<string>();
  const ref = (featureId: string, scheme: GtfsScheme, value: string) => {
    const k = refKey(scheme, value);
    // One feature per ref in a version: the first record to claim it keeps it.
    if (emitted.has(k)) return;
    emitted.add(k);
    const r = latest.get(k);
    if (r?.featureId === featureId) {
      if (r.lower <= seq && seq < r.upper) return;
      if (inPrevious(r)) {
        out.extendRefs.push({ rowId: r.rowId, upper: seq + 1 });
        return;
      }
    }
    out.insertRefs.push({
      featureId,
      scheme,
      value,
      lower: seq,
      upper: seq + 1,
    });
  };
  const newFeature = (
    kind: GtfsFeatureKind,
    name: string,
    pos: LonLat | null,
    parentId: string | null,
  ): NewFeature => {
    const f: NewFeature = {
      id: input.mint(kind),
      kind,
      name,
      lon: pos?.[0] ?? null,
      lat: pos?.[1] ?? null,
      parentId,
      feedId: kind === "stop" || kind === "route" ? feed : null,
      operatorId: kind === "stop" || kind === "route" ? operator : null,
    };
    out.mint.push(f);
    return f;
  };
  const refresh = (id: string, name: string, pos: LonLat | undefined) => {
    const f = features.get(id);
    if (!f) return;
    // A stop or exchange other feeds share follows its home feed only.
    if (
      (f.kind === "stop" || f.kind === "exchange")
      && f.feedId !== undefined
      && f.feedId !== feed
    )
      return;
    const u: FeatureUpdate = { id };
    if (!f.nameLocked && f.name !== name) u.name = name;
    if (pos && !f.geomLocked && (!located(f) || distM(at(f), pos) > MOVED_M)) {
      u.lon = pos[0];
      u.lat = pos[1];
    }
    if (u.name !== undefined || u.lon !== undefined) out.update.push(u);
  };
  const reactivate = (f: RegistryFeature, ref: string) => {
    if (f.status !== "retired" || out.reactivate.includes(f.id)) return;
    out.reactivate.push(f.id);
    flag(f.id, "retired-returned", [], { ref });
  };
  const flag = (
    featureId: string,
    reason: FlagReason,
    candidates: string[],
    detail: Record<string, unknown> = {},
  ) => out.flags.push({ featureId, reason, candidates, detail });

  const stops = records.stops
    .filter((s) => !s.station)
    .sort((a, b) => a.id.localeCompare(b.id));
  const parentStops = records.stops
    .filter((s) => s.station)
    .sort((a, b) => a.id.localeCompare(b.id));
  const parentIds = new Set(parentStops.map((s) => s.id));
  const standalone = stops.filter(
    (s) => s.nonBus && !(s.parent && parentIds.has(s.parent)),
  );

  // --- Stations: parent stops, and standalone rail and ferry stops, merged as the plan merges them.
  const stationOfParent = new Map<string, string>();
  const stationOfStandalone = new Map<string, string>();
  /** Each station group's feature and position, for the bays beside it. */
  const stationPlaces: {
    id: string;
    name: string;
    lon: number;
    lat: number;
  }[] = [];
  const stationFeaturesThisVersion = new Set<string>();
  const stationItems = [
    ...parentStops.map((s) => ({ ...s, name: stationName(s.name), stop: s })),
    ...standalone.map((s) => ({ ...s, name: stationName(s.name), stop: s })),
  ];
  // The current parent of an existing stop (by its gtfs-stop ref).
  const stopFeature = (s: FeedStop) => refFeature("gtfs-stop", s.id, "stop");
  for (const group of groupStations(stationItems)) {
    const rep = group[0]!;
    const parents = group.filter((m) => m.stop.station);
    const matched = new Map<string, string>();
    for (const p of parents) {
      const f = refFeature("gtfs-stop", p.id, "station");
      if (f) {
        matched.set(p.id, f.id);
        reactivate(f, `gtfs-stop:${feed}:${p.id}`);
      }
    }
    let id = majority([...matched.values()]);
    if (id === undefined && !parents.length) {
      // A station of standalone stops only: the station its stops are in.
      const ps = group
        .map((m) => stopFeature(m.stop)?.parentId)
        .filter((p): p is string => features.get(p ?? "")?.kind === "station");
      id = majority(ps);
    }
    const name = rep.name;
    if (id === undefined) {
      const sameName = (f: RegistryFeature) =>
        f.kind === "station"
        && f.status === "active"
        && located(f)
        && normalizeName(f.name) === normalizeName(name)
        && distM(at(f), at(rep)) < settings.stationMatchM;
      const candidate = nearest(
        snapshot.features.filter(
          (f) =>
            sameName(f)
            && f.feeds?.includes(feed)
            && !stationFeaturesThisVersion.has(f.id),
        ),
        at(rep),
      );
      if (candidate) id = candidate.id;
      else {
        id = newFeature("station", name, at(rep), null).id;
        const others = snapshot.features.filter(
          (f) => sameName(f) && !f.feeds?.includes(feed),
        );
        if (others.length)
          flag(
            id,
            "cross-feed-name-match",
            others.map((f) => f.id),
            { name },
          );
      }
    }
    stationFeaturesThisVersion.add(id);
    for (const m of group)
      if (m.stop.station) {
        const sid = matched.get(m.id) ?? id;
        stationOfParent.set(m.id, sid);
        stationFeaturesThisVersion.add(sid);
        ref(sid, "gtfs-stop", m.id);
      } else stationOfStandalone.set(m.id, id);
    stationPlaces.push({ id, name, lon: rep.lon, lat: rep.lat });
  }
  // Names and positions follow the newest version: a station's from its first parent stop here.
  const refreshed = new Set<string>();
  for (const place of stationPlaces) {
    if (refreshed.has(place.id)) continue;
    refreshed.add(place.id);
    const first = parentStops.find(
      (p) => stationOfParent.get(p.id) === place.id,
    );
    if (first) refresh(place.id, stationName(first.name), at(first));
    else refresh(place.id, place.name, at(place));
  }

  // --- Stops: by stop_id with the same code, by code, then (without a code) by name and distance.
  const claimed = new Set<string>();
  const featureOf = new Map<string, string>();
  const existing = new Set<string>();
  const byRule = new Map<string, 1 | 2 | 3 | 4>();
  const claim = (s: FeedStop, f: RegistryFeature, rule: 1 | 2 | 3 | 4) => {
    reactivate(
      f,
      rule === 2 ? `stop:${feed}:${s.code}` : `gtfs-stop:${feed}:${s.id}`,
    );
    claimed.add(f.id);
    featureOf.set(s.id, f.id);
    existing.add(s.id);
    byRule.set(s.id, rule);
  };
  for (const s of stops) {
    const f = stopFeature(s);
    if (f && !claimed.has(f.id) && codeOf.get(f.id)?.code === s.code)
      claim(s, f, 1);
  }
  for (const s of stops) {
    if (featureOf.has(s.id) || !s.code) continue;
    const f = refFeature("stop", s.code, "stop");
    if (f && !claimed.has(f.id)) claim(s, f, 2);
  }
  // This feed's stops: those it's the home feed of, and those other feeds share with it.
  const withRefs = new Set(snapshot.refs.map((r) => r.featureId));
  const feedStops = snapshot.features.filter(
    (f): f is RegistryFeature & { lon: number; lat: number } =>
      f.kind === "stop"
      && (f.feedId === feed || withRefs.has(f.id))
      && located(f),
  );
  const byName = new Map<
    string,
    (RegistryFeature & { lon: number; lat: number })[]
  >();
  for (const f of feedStops) {
    if (f.status !== "active") continue;
    const k = normalizeName(f.name);
    let l = byName.get(k);
    if (!l) byName.set(k, (l = []));
    l.push(f);
  }
  for (const s of stops) {
    if (featureOf.has(s.id) || s.code) continue;
    const f = nearest(
      (byName.get(normalizeName(s.name)) ?? []).filter(
        (c) =>
          !claimed.has(c.id) && distM(at(c), at(s)) < settings.stopNameMatchM,
      ),
      at(s),
    );
    if (f) claim(s, f, 3);
  }
  // 4. Another feed's stop that's the same physical stop (docs/DESIGN.md#shared-stops).
  const sharedNear = sharedStopIndex(snapshot.shared, settings);
  /** How each stop claimed by rule 4 matched, for its flag. */
  const sharedHow = new Map<string, { match: SharedMatch; m: number }>();
  for (const s of stops) {
    if (featureOf.has(s.id)) continue;
    const best = bestShared(
      {
        id: s.id,
        name: s.name,
        lon: s.lon,
        lat: s.lat,
        feeds: [{ feed, operator, code: s.code }],
      },
      sharedNear(s).filter(
        (c) => !claimed.has(c.id) && features.get(c.id)?.status === "active",
      ),
      settings,
    );
    if (!best) continue;
    claim(s, features.get(best.stop.id)!, 4);
    sharedHow.set(s.id, { match: best.match, m: best.m });
  }

  // --- Containment proposed for the stops: platforms and standalone stops their station's; bays
  // their group's.
  const proposed = new Map<string, string>();
  for (const s of stops) {
    const p =
      s.parent && parentIds.has(s.parent) ?
        stationOfParent.get(s.parent)
      : stationOfStandalone.get(s.id);
    if (p) proposed.set(s.id, p);
  }
  const bays = stops.filter(
    (s) => !proposed.has(s.id) && !s.parent && isBay(s.name),
  );
  const bayGroups = groupBays(bays, stationPlaces);
  const stopById = new Map(stops.map((s) => [s.id, s]));
  /** Each new bay's parent (null: none), decided by its group. */
  const bayParent = new Map<string, string | null>();
  /** Exchanges minted here, with their bays, for the exchange-replaced check. */
  const mintedExchanges: { id: string; pos: LonLat; name: string }[] = [];
  for (const g of bayGroups) {
    const old = g.bays.filter((id) => existing.has(id));
    if (old.length) {
      // The group's stops already have parents: new bays take the most common, none included.
      const parentOf = (id: string) =>
        features.get(featureOf.get(id)!)?.parentId ?? null;
      const m = majority(old.map(parentOf)) ?? null;
      for (const id of g.bays) if (!existing.has(id)) bayParent.set(id, m);
      for (const id of old)
        if (parentOf(id) !== m)
          flag(featureOf.get(id)!, "grouping-differs", m ? [m] : [], {
            proposed: m,
            parent: parentOf(id),
            group: g.name,
          });
      continue;
    }
    let parent = g.station;
    if (!parent) {
      const pos = centroid(g.bays.map((id) => stopById.get(id)!));
      // Another feed's exchange of the same name here is this one (docs/DESIGN.md#shared-stops):
      // Okanagan-Shuswap's buses at Kelowna's Westbank Exchange.
      parent = nearest(
        snapshot.features.filter(
          (f) =>
            f.kind === "exchange"
            && f.status === "active"
            && f.feedId !== undefined
            && f.feedId !== feed
            && located(f)
            && normalizeName(f.name) === normalizeName(g.name)
            && distM(at(f), pos) < settings.exchangeMatchM,
        ),
        pos,
      )?.id;
      if (!parent) {
        parent = newFeature("exchange", g.name, pos, null).id;
        mintedExchanges.push({ id: parent, pos, name: g.name });
      }
    }
    for (const id of g.bays) bayParent.set(id, parent);
  }

  // --- Mint the new stops, flag what may be wrong, and write every stop's refs.
  for (const s of stops) {
    let id = featureOf.get(s.id);
    if (id === undefined) {
      const parent = bayParent.get(s.id) ?? proposed.get(s.id) ?? null;
      id = newFeature("stop", s.name, at(s), parent).id;
      featureOf.set(s.id, id);
    } else {
      const f = features.get(id)!;
      const rule = byRule.get(s.id)!;
      const how = sharedHow.get(s.id);
      // Matched by nearness to another operator's stop: an admin can check it's the same.
      if (how?.match === "near")
        flag(id, "shared-stop", [], {
          feed,
          stopId: s.id,
          code: s.code ?? null,
          m: Math.round(how.m),
        });
      if (
        (rule === 1 || rule === 2)
        && located(f)
        && distM(at(f), at(s)) > settings.stopMovedFarM
      )
        flag(id, "code-moved-far", [], {
          stopId: s.id,
          code: s.code ?? null,
          movedM: Math.round(distM(at(f), at(s))),
        });
      const p = proposed.get(s.id);
      if (p !== undefined && p !== (f.parentId ?? undefined))
        flag(id, "grouping-differs", [p], {
          proposed: p,
          parent: f.parentId ?? null,
        });
      refresh(id, s.name, at(s));
    }
    ref(id, "gtfs-stop", s.id);
    if (s.code) ref(id, "stop", s.code);
  }
  const disappeared = feedStops.filter(
    (f) =>
      f.status === "active"
      && !claimed.has(f.id)
      && snapshot.refs.some(
        (r) =>
          r.featureId === f.id && r.scheme === "gtfs-stop" && inPrevious(r),
      ),
  );
  if (disappeared.length)
    for (const n of out.mint) {
      if (n.kind !== "stop") continue;
      const near = disappeared.filter(
        (f) => distM(at(f), [n.lon!, n.lat!]) < settings.disappearedNearM,
      );
      if (near.length)
        flag(
          n.id,
          "disappeared-nearby",
          near.map((f) => f.id),
          {
            name: n.name,
            // What an admin weighs: the stops that disappeared, and how far away they were.
            near: near.map((f) => ({
              id: f.id,
              name: f.name,
              m: Math.round(distM(at(f), [n.lon!, n.lat!])),
            })),
          },
        );
    }

  // --- Exchanges: names and positions from the stops in them in this version; a new exchange
  // beside one that lost all its stops may replace it.
  const parentNow = new Map<string, string>();
  for (const f of snapshot.features)
    if (f.kind === "stop" && f.parentId) parentNow.set(f.id, f.parentId);
  for (const n of out.mint) if (n.parentId) parentNow.set(n.id, n.parentId);
  const present = new Map<string, FeedStop[]>();
  for (const s of stops) {
    const p = parentNow.get(featureOf.get(s.id)!);
    if (!p) continue;
    let l = present.get(p);
    if (!l) present.set(p, (l = []));
    l.push(s);
  }
  for (const f of snapshot.features) {
    if (f.kind !== "exchange" || f.status !== "active") continue;
    const inIt = present.get(f.id);
    if (!inIt?.length) continue;
    const name = majority(inIt.map((s) => baseName(s.name))) ?? f.name;
    refresh(f.id, name, centroid(inIt));
  }
  for (const n of mintedExchanges) {
    // This feed's own exchanges (`present` only has this feed's stops: another feed's exchange
    // always looks empty), or ones with no stops at all.
    const lost = snapshot.features.filter(
      (f) =>
        f.kind === "exchange"
        && f.status === "active"
        && (f.feedId === undefined || f.feedId === feed)
        && located(f)
        && !present.get(f.id)?.length
        && distM(at(f), n.pos) < settings.exchangeReplacedM,
    );
    if (lost.length)
      flag(
        n.id,
        "exchange-replaced",
        lost.map((f) => f.id),
        { name: n.name },
      );
  }

  // --- Routes: the same name in the same feed is the same route; in a feed keyed by route_id (whose
  // systems each have a 1), the same route_id is.
  const byRouteId = input.routeKey === "route_id";
  const routesByName = new Map<string, string>();
  if (!byRouteId)
    for (const f of snapshot.features)
      if (f.kind === "route" && f.feedId === feed && f.status === "active") {
        const k = normalizeName(f.name);
        if (!routesByName.has(k)) routesByName.set(k, f.id);
      }
  for (const r of [...records.routes].sort((a, b) =>
    a.id.localeCompare(b.id),
  )) {
    const name = routeName(r);
    let id: string | undefined;
    if (byRouteId) {
      const f = refFeature("gtfs-route", r.id, "route");
      if (f) reactivate(f, `gtfs-route:${feed}:${r.id}`);
      id = f?.id;
      if (id === undefined) id = newFeature("route", name, null, null).id;
      else refresh(id, name, undefined);
    } else {
      const k = normalizeName(name);
      id = routesByName.get(k);
      if (id === undefined) {
        id = newFeature("route", name, null, null).id;
        routesByName.set(k, id);
      } else refresh(id, name, undefined);
    }
    ref(id, "gtfs-route", r.id);
  }
  return out;
}
