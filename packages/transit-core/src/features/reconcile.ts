// Feature reconciliation (docs/DESIGN.md#feature-ids, apps/server/README.md#feature-reconciliation):
// which feature each stop, station and route of a GTFS feed version belongs to, which are new, and
// which station or exchange a new stop belongs to. Pure: (registry snapshot, the feed's stops and
// routes, settings) → decisions, which the server applies. It never blocks: a doubtful case is
// minted as a new feature and flagged for an admin, who can merge it afterwards.
//
// Containment is the registry's (docs/DESIGN.md#relationships-between-features): the station and
// bay heuristics only propose a parent for a stop when it's first minted, and an existing stop's
// parent is never changed here, even when it has none.

import type { Config } from "../config.ts";
import { distM, type LonLat } from "../geo.ts";
import { baseName, groupBays, isBay } from "../plan/exchanges.ts";
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
  /** The feed a stop or route comes from. */
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
  /** This feed's stops and routes, and every station and exchange. */
  features: RegistryFeature[];
  /** The newest range of each of this feed's refs. */
  refs: RegistryRef[];
}

export interface ReconcileInput {
  feed: string;
  operator: string;
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
  | "code-moved-far"
  | "disappeared-nearby"
  | "cross-feed-name-match"
  | "exchange-replaced"
  | "grouping-differs";

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
    const u: FeatureUpdate = { id };
    if (!f.nameLocked && f.name !== name) u.name = name;
    if (pos && !f.geomLocked && (!located(f) || distM(at(f), pos) > MOVED_M)) {
      u.lon = pos[0];
      u.lat = pos[1];
    }
    if (u.name !== undefined || u.lon !== undefined) out.update.push(u);
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
      if (f) matched.set(p.id, f.id);
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
  const byRule = new Map<string, 1 | 2 | 3>();
  const claim = (s: FeedStop, f: RegistryFeature, rule: 1 | 2 | 3) => {
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
  const feedStops = snapshot.features.filter(
    (f): f is RegistryFeature & { lon: number; lat: number } =>
      f.kind === "stop" && f.feedId === feed && located(f),
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
      parent = newFeature("exchange", g.name, pos, null).id;
      mintedExchanges.push({ id: parent, pos, name: g.name });
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
      if (
        rule !== 3
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
          { name: n.name },
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
    const lost = snapshot.features.filter(
      (f) =>
        f.kind === "exchange"
        && f.status === "active"
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

  // --- Routes: the same name in the same feed is the same route.
  const routesByName = new Map<string, string>();
  for (const f of snapshot.features)
    if (f.kind === "route" && f.feedId === feed && f.status === "active") {
      const k = normalizeName(f.name);
      if (!routesByName.has(k)) routesByName.set(k, f.id);
    }
  for (const r of [...records.routes].sort((a, b) =>
    a.id.localeCompare(b.id),
  )) {
    const name = routeName(r);
    const k = normalizeName(name);
    let id = routesByName.get(k);
    if (id === undefined) {
      id = newFeature("route", name, null, null).id;
      routesByName.set(k, id);
    } else refresh(id, name, undefined);
    ref(id, "gtfs-route", r.id);
  }
  return out;
}
