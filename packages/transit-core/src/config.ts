// The committed config (config/: docs/DESIGN.md#regions-and-feeds): global defaults
// (config/defaults/), operators (config/operators/<id>/operator.json), feeds
// (config/feeds/<id>/feed.json, routes.json) and regions (config/regions/<id>/region.json and its
// settings files): one schema each,
// checked wherever a file is loaded (site, server, pipelines) and by a test over every committed file,
// so a misspelled or mistyped setting fails loudly instead of reading as undefined. Keys starting with
// "$" are comments (the files cite their sources there) and are dropped before checking, at any depth.
// Where the engine already has a type for a section, its schema is checked against that type.

import * as z from "zod";
import type { Kinematics, KinematicsConfig } from "./movement/kinematics.ts";
import type { OperationsConfig } from "./movement/build.ts";
import type { ObservedConfig } from "./rt/observed.ts";
import type { StatsConfig } from "./rt/stats.ts";
import type { CadenceConfig, PollBand, PollSchedule } from "./rt/budget.ts";
import type { PredictionConfig } from "./rt/profile.ts";
import type { CarryConfig } from "./rt/carry.ts";
import type { AisMatchConfig } from "./ais/match.ts";
import type { GlideConfig } from "./ais/glide.ts";
import type { RouteCategory, RouteKind, RouteMode } from "./plan/types.ts";

/** The value without its "$" comment keys, at any depth. */
export function stripComments(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripComments);
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v)
        .filter(([k]) => !k.startsWith("$"))
        .map(([k, x]) => [k, stripComments(x)]),
    );
  return v;
}

const num = z.number(); // finite: zod rejects NaN and ±Infinity
const nonNeg = num.nonnegative();
const pos = num.positive();
const count = z.number().int().nonnegative();
const share = num.min(0).max(1);
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const hhmm = z.string().regex(HHMM, "expected local time as HH:MM");
const minuteOfDay = (s: string) =>
  Number(s.slice(0, 2)) * 60 + Number(s.slice(3));

// --- dispatch.json ---

// Checked against DispatchConfig where it reaches the dispatcher: importing that type from
// dispatch/sim.ts would bring its Node-only debug switches into the browser engine's typecheck.
const dispatch = z.strictObject({
  stepS: pos,
  safetyMarginM: nonNeg,
  foulingM: nonNeg,
  minHoldS: nonNeg,
  maxWaitS: pos,
  crossingBufferS: nonNeg,
  singleTrackHeadwayS: pos,
  revenueFirst: z.boolean(),
});

// --- kinematics.json ---

const kinematicsShape = {
  accel: pos,
  decel: pos,
  maxSpeed: pos,
  minCruiseFraction: share,
  dwell: nonNeg,
  length: pos,
  width: pos,
  profile: z.enum(["trapezoid", "linear"]),
};

const kinematicsMode: z.ZodType<Kinematics> = z.strictObject(kinematicsShape);

/** Per-route overrides: any of a mode's settings. */
const kinematicsOverride: z.ZodType<Partial<Kinematics>> = z.strictObject(
  Object.fromEntries(
    Object.entries(kinematicsShape).map(([k, s]) => [k, s.exactOptional()]),
  ) as {
    [K in keyof typeof kinematicsShape]: z.ZodExactOptional<
      (typeof kinematicsShape)[K]
    >;
  },
);

const kinematics: z.ZodType<KinematicsConfig> = z
  .strictObject({
    modes: z.record(z.string(), kinematicsMode),
    routes: z.record(z.string(), kinematicsOverride),
    sizing: z.strictObject({ minPixelLength: pos, minPixelWidth: pos }),
  })
  .refine((c) => c.modes["bus"] !== undefined, {
    message: "modes needs bus (the fallback for any other mode)",
    path: ["modes"],
  });

// --- operations.json ---

const operations: z.ZodType<OperationsConfig> = z.strictObject({
  fleets: z.strictObject({ groups: z.array(z.array(z.string()).min(1)) }),
  turnback: z.strictObject({
    minLayoverS: nonNeg,
    maxLayoverS: pos,
    maxTurnbackM: pos,
    stubMaxLayoverS: pos,
    maxPullUpM: nonNeg,
    speedFactor: pos,
    unloadS: nonNeg,
    reversalS: nonNeg,
    blockBonusS: nonNeg,
  }),
  yard: z.strictObject({
    maxDeadheadM: pos,
    pullOutLeadS: nonNeg,
    deadheadSpeedFactor: pos,
    runIntoYardM: nonNeg,
    againstTrafficPenalty: nonNeg,
  }),
});

// --- config/server/: server.json, recording.json ---

/** When /healthz fails a feed's trip updates for matching too few buses (apps/server/README.md#real-time-service). */
const tripUpdatesHealth = z.strictObject({
  minCoverage: share,
  minBuses: z.number().int().positive(),
  lowForS: pos,
});

const server = z.strictObject({
  port: z.number().int().min(1).max(65535),
  /** Live dispatch (apps/server/README.md#live-dispatch-and-previews). */
  dispatchCheckS: pos,
  dispatchWindowDays: count,
  /** The default for every feed; feed.json → realtime.tripUpdatesHealth overrides it. */
  tripUpdatesHealth,
});

const observed: z.ZodType<ObservedConfig> = z.strictObject({
  maxOffsetM: pos,
  maxGapS: pos,
  stopToleranceM: nonNeg,
  backtrackM: nonNeg,
});

const stats: z.ZodType<StatsConfig> = z.strictObject({
  onTimeS: z
    .tuple([num, num])
    .refine(([early, late]) => early <= late, "onTimeS is [early, late]"),
  maxPrecisionS: pos,
  minTripCoverage: share,
  bunchingShare: share,
  bands: z
    .array(
      z
        .strictObject({ id: z.string().min(1), fromS: nonNeg, toS: pos })
        .refine((b) => b.fromS < b.toS, "a band ends after it starts"),
    )
    .min(1),
});

const recording = z.strictObject({
  retentionDays: z.number().int().positive(),
  observed,
  stats,
  afterServiceDayH: pos,
  dataBuildAt: hhmm,
});

// --- config/features/reconcile.json ---

const reconcile = z.strictObject({
  stopNameMatchM: pos,
  stopMovedFarM: pos,
  disappearedNearM: pos,
  stationMatchM: pos,
  exchangeReplacedM: pos,
});

// --- config/feeds/<feed>/routes.json ---

const routeKinds = ["skytrain", "shape", "bus"] as const satisfies RouteKind[];
const routeModes = [
  "skytrain",
  "ferry",
  "rail",
  "bus",
] as const satisfies RouteMode[];
const routeCategories = [
  "rapid",
  "frequent",
  "regular",
] as const satisfies RouteCategory[];

/** GTFS routes are selected by name, never by route_id (which changes between feeds). */
const routeMatch = z
  .strictObject({
    route_long_name: z.string().min(1).exactOptional(),
    route_short_name: z.string().min(1).exactOptional(),
  })
  .refine(
    (m) => m.route_long_name !== undefined || m.route_short_name !== undefined,
    "match needs route_long_name or route_short_name",
  );

/**
 * One route's overrides of what the plan takes from the GTFS (plan/routes.ts → `selectRoutes`):
 * every route in a feed is drawn by default, so only routes drawn differently are listed.
 */
const route = z.strictObject({
  /** The route's key, what other config (kinematics, SeaBus, regions) and URLs name it by. */
  key: z.string().min(1),
  match: routeMatch,
  label: z.string().min(1).exactOptional(),
  kind: z.enum(routeKinds).exactOptional(),
  mode: z.enum(routeModes).exactOptional(),
  category: z.enum(routeCategories).exactOptional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "expected #rrggbb")
    .exactOptional(),
  /** Overrides of its mode's vehicle settings (config/defaults/kinematics.json, then its operator's). */
  kinematics: kinematicsOverride.exactOptional(),
});

const routes = z.strictObject({
  routes: z
    .array(route)
    .refine(
      (rs) => new Set(rs.map((r) => r.key)).size === rs.length,
      "route keys must be unique",
    ),
  /** Routes in the feed the plan leaves out: not drawn, not on cards, not tracked. */
  exclude: z.array(z.strictObject({ match: routeMatch })).exactOptional(),
});

// --- rt.json ---

const pollBands = z
  .array(
    z.strictObject({
      from: hhmm,
      positionsS: pos,
      tripUpdatesS: pos,
      alertsS: pos,
    }) satisfies z.ZodType<PollBand>,
  )
  .min(1)
  .refine((bs) => bs[0]?.from === "00:00", "the first band starts at 00:00")
  .refine(
    (bs) =>
      bs.every(
        (b, i) => i === 0 || minuteOfDay(bs[i - 1]!.from) < minuteOfDay(b.from),
      ),
    "bands are sorted by from, without repeats",
  );

const poll: z.ZodType<PollSchedule> = z.strictObject({
  dailyCap: z.number().int().positive(),
  weekday: pollBands,
  weekend: pollBands,
});

// Also profileHistoryDays, for the profile build (not part of prediction itself).
const prediction = z.strictObject({
  binM: pos,
  bandStartHours: z
    .array(z.number().int().min(0).max(23))
    .min(1)
    .refine(
      (hs) => hs[0] === 0 && hs.every((h, i) => i === 0 || hs[i - 1]! < h),
      "bandStartHours ascend from 0",
    ),
  maxPairS: pos,
  maxOffsetM: pos,
  stationaryM: nonNeg,
  stopZoneM: nonNeg,
  stopExcessM: nonNeg,
  baselineWindowM: pos,
  minBinMetres: nonNeg,
  minStopPasses: count,
  defaultSpeedMps: pos,
  defaultDwellS: nonNeg,
  minDwellS: nonNeg,
  paceWindowS: nonNeg,
  paceWeight: share,
  paceClamp: z
    .tuple([pos, pos])
    .refine(([lo, hi]) => lo <= hi, "paceClamp is [min, max]"),
  catchUpMps: pos,
  minGlideS: nonNeg,
  maxGlideS: pos,
  snapM: pos,
  scheduleAnchorS: nonNeg,
  profileHistoryDays: z.number().int().positive(),
}) satisfies z.ZodType<PredictionConfig>;

const carryShape = z.strictObject({
  minLayoverS: nonNeg,
  maxTrips: count,
});
const carry: z.ZodType<CarryConfig> = carryShape;

// How the map uses real-time data, resolved from config/defaults/rt.json, an operator's overrides
// and a region's (resolveRt). How often each feed is polled, and the thresholds that follow from it,
// are the feed's (feed.json → realtime).
const rt = z.strictObject({
  clientPollS: pos,
  clientPollMaxS: pos,
  clientPollSlackS: nonNeg,
  detourNearM: pos,
  prediction,
  carry,
});

// --- seabus.json ---

const aisMatch: z.ZodType<AisMatchConfig> = z.strictObject({
  maxOffsetM: pos,
  maxShiftS: pos,
  stationaryKn: nonNeg,
  dockRadiusM: pos,
  courseToleranceDeg: z.number().min(0).max(180),
  minTurnaroundS: nonNeg,
  maxCarryTrips: count,
  pairMinFixes: z.number().int().positive(),
});

const glide: z.ZodType<GlideConfig> = z.strictObject({
  minM: nonNeg,
  snapM: pos,
  catchUpMps: pos,
  minGlideS: nonNeg,
  maxGlideS: pos,
  maxHoldS: nonNeg,
});

const latLon = z.tuple([num.min(-90).max(90), num.min(-180).max(180)]);

const seabus = z.strictObject({
  /** The berth pair every vessel uses unless AIS shows otherwise (FerryConfig). */
  defaultPair: z.string().min(1),
});

/** A feed's vessels' AIS positions (feed.json → ais; packages/transit-core/DESIGN.md#seabus-ais). */
const feedAis = z.strictObject({
  /** The route (routes.json key) whose vessels these are. */
  route: z.string().min(1),
  vessels: z
    .array(
      z.strictObject({
        mmsi: z.string().regex(/^\d{9}$/, "an MMSI is 9 digits"),
        name: z.string().min(1),
      }),
    )
    .min(1),
  /** [[lat, lon], [lat, lon]]: opposite corners. */
  boundingBox: z.tuple([latLon, latLon]),
  batchS: pos,
  coverageGapS: pos,
  liveWindowS: pos,
  maxBackoffS: pos,
  match: aisMatch,
  glide,
});

// --- layers over the defaults: an operator's and a feed's overrides ---

/** Overrides of config/defaults/kinematics.json: any of a mode's settings. */
const kinematicsLayer = z.strictObject({
  modes: z.record(z.string(), kinematicsOverride),
});

/** Overrides of config/defaults/rt.json that depend on the vehicles and data: prediction, carried delays, detours. */
const rtLayer = z.strictObject({
  prediction: prediction.partial().exactOptional(),
  carry: carryShape.partial().exactOptional(),
  detourNearM: pos.exactOptional(),
});

// --- config/feeds/<feed>/feed.json ---

/** Ids of regions and feeds: they name directories, URL segments and database keys. */
const slug = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "expected a lower-case-slug");
const httpsUrl = z.url({ protocol: /^https$/ });
const API_KEY_SLOT = "{apiKey}";

const feedRealtime = z
  .strictObject({
    /**
     * The key's name in the environment or .secrets, when the provider needs one: it replaces
     * {apiKey} in the URLs. Keys never reach the browser, logs or errors.
     */
    apiKey: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/, "an environment variable name")
      .exactOptional(),
    urls: z.strictObject({
      positions: z.string().startsWith("https://"),
      tripUpdates: z.string().startsWith("https://"),
      alerts: z.string().startsWith("https://"),
    }),
    poll,
    staleGraceS: nonNeg,
    coverageSlackS: nonNeg,
    interpolateSlackS: nonNeg,
    extrapolateSlackS: nonNeg,
    /** Overrides of config/server/server.json → tripUpdatesHealth. */
    tripUpdatesHealth: tripUpdatesHealth.partial().exactOptional(),
  })
  .refine(
    (r) =>
      Object.values(r.urls).every(
        (u) => u.includes(API_KEY_SLOT) === (r.apiKey !== undefined),
      ),
    `every URL has ${API_KEY_SLOT} when apiKey is set, and none without it`,
  ) satisfies z.ZodType<CadenceConfig>;

/** A regular expression whose first group is the short form of an id (packages/transit-core/src/plan/display.ts). */
const shortPattern = z.string().refine((p) => {
  try {
    return new RegExp(`${p}|`).exec("")!.length > 1;
  } catch {
    return false;
  }
}, "expected a regular expression with a group");

const feed = z.strictObject({
  id: slug,
  /** How the site names the feed, e.g. "BC Transit (Victoria)". */
  name: z.string().min(1),
  /** Who runs the service (config/operators/<id>/operator.json). */
  operator: slug,
  /** Must match the regions' showing it, and the feed's agency_timezone. */
  timezone: z.string().min(1),
  /** The dataset registry id of its schedules (packages/shared/src/datasets.ts); real time is that dataset's `realtime`. */
  dataset: z.string().min(1),
  static: z.strictObject({
    /** The latest GTFS feed. */
    url: httpsUrl,
    /** A dated snapshot ({date}: YYYY-MM-DD), where the provider keeps them. */
    historyUrl: z.string().includes("{date}").exactOptional(),
  }),
  /** GTFS-realtime, polled by the server's leader only (docs/DESIGN.md#upstream-request-budget). */
  realtime: feedRealtime.exactOptional(),
  /** Its vessels' AIS positions, streamed by the server's leader (aisstream.io). */
  ais: feedAis.exactOptional(),
  /** Overrides of its operator's vehicle settings, for this system's buses (e.g. a fleet of double-deckers). */
  kinematics: kinematicsLayer.exactOptional(),
  /**
   * Overrides of its operator's settings for using its real-time data (prediction tuned on this
   * system's recordings). Not to be confused with `realtime`, where the data comes from.
   */
  rt: rtLayer.exactOptional(),
  /** How its ids are shown to riders: a regex each, whose first group is the short form; absent, the whole id. */
  display: z
    .strictObject({
      tripId: shortPattern.exactOptional(),
      feedVersion: shortPattern.exactOptional(),
    })
    .exactOptional(),
});

// --- config/operators/<id>/operator.json ---

const operator = z.strictObject({
  id: slug,
  /** How riders know it ("BC Transit"): plans record it, and sources name it. */
  name: z.string().min(1),
  kinematics: kinematicsLayer.exactOptional(),
  rt: rtLayer.exactOptional(),
});

/**
 * A region's rt.json: settings about the place only (how its map polls), never about
 * the vehicles or their data, which are the feeds' and operators' (a region can show several).
 */
const regionRt = rt
  .pick({
    clientPollS: true,
    clientPollMaxS: true,
    clientPollSlackS: true,
  })
  .partial();

// --- config/regions/<id>/region.json ---

const lon = num.min(-180).max(180);
const lat = num.min(-90).max(90);
/** [west, south, east, north]. */
const bounds = z
  .tuple([lon, lat, lon, lat])
  .refine(([w, s, e, n]) => w < e && s < n, "[west, south, east, north]");

const region = z.strictObject({
  id: slug,
  name: z.string().min(1),
  timezone: z.string().min(1),
  /**
   * The feeds whose transit the region shows (config/feeds/<id>/). A feed can be in several regions (a
   * ferry between two), and it is fetched, built, polled and recorded once whichever regions show it.
   */
  feeds: z
    .array(slug)
    .min(1)
    .refine((fs) => new Set(fs).size === fs.length, "feeds are listed once"),
  /** Where the region's transit data applies. */
  bbox: bounds,
  /** The first view of /transit when the URL has no map position. */
  initialBounds: bounds,
  timezoneChecks: z.array(
    z.strictObject({
      at: z.iso.datetime(),
      utcOffsetMinutes: z.number().int(),
      reason: z.string().min(1),
    }),
  ),
});

export type FeedInfo = z.output<typeof feed>;
export type OperatorInfo = z.output<typeof operator>;
export type FeedAis = z.output<typeof feedAis>;
export type RegionRt = z.output<typeof regionRt>;
export type FeedRealtime = z.output<typeof feedRealtime>;
export type RegionInfo = z.output<typeof region>;

function parsed<T>(schema: z.ZodType<T>, file: string, json: unknown): T {
  const r = schema.safeParse(stripComments(json));
  if (r.success) return r.data;
  const problems = r.error.issues.map(
    (i) => `${i.path.length ? i.path.join(".") : "(top level)"}: ${i.message}`,
  );
  throw new Error(`Bad ${file}: ${problems.join("; ")}`);
}

/** An operator's operator.json, checked. */
export function parseOperator(json: unknown): OperatorInfo {
  return parsed(operator, "operator.json", json);
}

/** A region's rt.json (overrides of the defaults), checked. */
export function parseRegionRt(json: unknown): RegionRt {
  return parsed(regionRt, "region rt.json", json);
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** `over` laid over `base`, objects merged key by key, anything else (arrays too) replaced. */
function mergeLayers(base: unknown, over: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(over))
    return over === undefined ? base : over;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = mergeLayers(base[k], v);
  return out;
}

/**
 * A feed's vehicle settings: config/defaults/kinematics.json, its operator's overrides per mode, its
 * own (feed.json → kinematics), and its routes' (routes.json → kinematics). The result is checked whole.
 */
export function resolveKinematics(
  defaults: unknown,
  op: OperatorInfo,
  feed: Pick<FeedInfo, "kinematics">,
  routeConfigs: readonly RouteConfig[],
): Config<"kinematics"> {
  const d = stripComments(defaults) as Record<string, unknown>;
  return parseConfig("kinematics", {
    ...d,
    modes: mergeLayers(
      mergeLayers(d["modes"], op.kinematics?.modes ?? {}),
      feed.kinematics?.modes ?? {},
    ),
    routes: Object.fromEntries(
      routeConfigs.flatMap((r) =>
        r.kinematics ? [[r.key, r.kinematics]] : [],
      ),
    ),
  });
}

/**
 * Real-time settings for a feed in a region: config/defaults/rt.json, the feed's operator's
 * overrides, the feed's, then the region's (its rt.json, if it has one: settings about the place
 * only, so they never collide with the others). The result is checked whole.
 */
export function resolveRt(
  defaults: unknown,
  op: OperatorInfo,
  feed: Pick<FeedInfo, "rt">,
  region?: RegionRt,
): Config<"rt"> {
  let merged = stripComments(defaults);
  for (const layer of [op.rt, feed.rt, region])
    merged = mergeLayers(merged, layer ?? {});
  return parseConfig("rt", merged);
}

/** A feed's feed.json, checked. */
export function parseFeed(json: unknown): FeedInfo {
  return parsed(feed, "feed.json", json);
}

/** A region's region.json, checked. */
export function parseRegion(json: unknown): RegionInfo {
  return parsed(region, "region.json", json);
}

/** A feed's real-time URL with its key filled in. Never log or return the result. */
export function realtimeUrl(
  rt: FeedRealtime,
  endpoint: keyof FeedRealtime["urls"],
  apiKey: string | undefined,
): string {
  const url = rt.urls[endpoint];
  if (rt.apiKey === undefined) return url;
  if (!apiKey) throw new Error(`no ${rt.apiKey}`);
  return url.replace(API_KEY_SLOT, encodeURIComponent(apiKey));
}

// --- the files ---

/** Each config file's schema, by its name without ".json". */
export const CONFIG_SCHEMAS = {
  dispatch,
  kinematics,
  operations,
  reconcile,
  recording,
  routes,
  rt,
  seabus,
  server,
} as const;

export type ConfigName = keyof typeof CONFIG_SCHEMAS;
export type Config<N extends ConfigName> = z.output<(typeof CONFIG_SCHEMAS)[N]>;
export type RouteConfig = z.output<typeof route>;
export type RouteMatch = z.output<typeof routeMatch>;

/**
 * A config file's contents (parsed JSON), without comments and checked against its schema. Throws
 * naming the file and every problem in it.
 */
export function parseConfig<N extends ConfigName>(
  name: N,
  json: unknown,
): Config<N> {
  return parsed(
    CONFIG_SCHEMAS[name] as z.ZodType<Config<N>>,
    `config ${name}.json`,
    json,
  );
}
