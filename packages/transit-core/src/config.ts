// The region's config files (regions/<region>/config/*.json): one schema each, checked wherever a
// file is loaded (site, server, pipelines) and by a test over every committed file, so a misspelled
// or mistyped setting fails loudly instead of reading as undefined. Keys starting with "$" are
// comments (the files cite their sources there) and are dropped before checking, at any depth.
// Where the engine already has a type for a section, its schema is checked against that type.

import * as z from "zod";
import type { Kinematics, KinematicsConfig } from "./movement/kinematics.ts";
import type { OperationsConfig } from "./movement/build.ts";
import type { ObservedConfig } from "./rt/observed.ts";
import type { StatsConfig } from "./rt/stats.ts";
import type { PollBand, PollSchedule } from "./rt/budget.ts";
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

// --- recording.json ---

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

// --- routes.json ---

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

const route = z.strictObject({
  key: z.string().min(1),
  label: z.string().min(1),
  /** GTFS routes are selected by name, never by route_id (which changes between feeds). */
  match: z
    .strictObject({
      route_long_name: z.string().min(1).exactOptional(),
      route_short_name: z.string().min(1).exactOptional(),
    })
    .refine(
      (m) =>
        m.route_long_name !== undefined || m.route_short_name !== undefined,
      "match needs route_long_name or route_short_name",
    ),
  kind: z.enum(routeKinds),
  mode: z.enum(routeModes),
  category: z.enum(routeCategories),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "expected #rrggbb")
    .exactOptional(),
});

const routes = z.strictObject({
  routes: z
    .array(route)
    .min(1)
    .refine(
      (rs) => new Set(rs.map((r) => r.key)).size === rs.length,
      "route keys must be unique",
    ),
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

const carry: z.ZodType<CarryConfig> = z.strictObject({
  minLayoverS: nonNeg,
  maxTrips: count,
});

const rt = z.strictObject({
  poll,
  staleGraceS: nonNeg,
  coverageSlackS: nonNeg,
  interpolateSlackS: nonNeg,
  extrapolateSlackS: nonNeg,
  clientPollS: pos,
  tripUpdatesMinCoverage: share,
  detourNearM: pos,
  dispatchCheckS: pos,
  dispatchWindowDays: count,
  serverPort: z.number().int().min(1).max(65535),
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
  ais: z.strictObject({
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
    maxBackoffS: pos,
    match: aisMatch,
    glide,
  }),
});

// --- the files ---

/** Each config file's schema, by its name without ".json". */
export const CONFIG_SCHEMAS = {
  dispatch,
  kinematics,
  operations,
  recording,
  routes,
  rt,
  seabus,
} as const;

export type ConfigName = keyof typeof CONFIG_SCHEMAS;
export type Config<N extends ConfigName> = z.output<(typeof CONFIG_SCHEMAS)[N]>;
export type RouteConfig = z.output<typeof route>;

/**
 * A config file's contents (parsed JSON), without comments and checked against its schema. Throws
 * naming the file and every problem in it.
 */
export function parseConfig<N extends ConfigName>(
  name: N,
  json: unknown,
): Config<N> {
  const r = CONFIG_SCHEMAS[name].safeParse(stripComments(json));
  if (r.success) return r.data as Config<N>;
  const problems = r.error.issues.map(
    (i) => `${i.path.length ? i.path.join(".") : "(top level)"}: ${i.message}`,
  );
  throw new Error(`Bad config ${name}.json: ${problems.join("; ")}`);
}
