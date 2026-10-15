// Compare ground-truth GPX tracks ridden on a bus with recorded GTFS-RT data and what the live view
// showed (packages/transit-core/DESIGN.md#buses → Evaluation). Per GPX file:
//   1. GTFS-RT fixes vs truth: position error, along-route error, and how stale each fix's timestamp is
//      (when the bus was really where the fix puts it), plus fix age when fetched.
//   2. Where the bus stopped: dwell at each stop (and stops elsewhere: signals, traffic) vs the
//      profile's expected dwell.
//   3. Live view vs truth every 2 s, replaying snapshots as fetched (old dead reckoning, and the
//      profile prediction with the current settings or --set overrides), by time since the last fetch.
//   4. Recorded playback vs truth (every fix known: interpolation between fixes).
//
//   npx tsx pipelines/eval-gpx.ts [<file.gpx> ...] [--set key=value[,key=value]] [--quiet]
//
// GPX files are named <date>-<route>-<from>-<to>-B<bus label>-<trip_id>.gpx (config/regions/metro-vancouver/observations/gpx/);
// with no files, every such file there. The profile is trained on recorded hours before the GPX's day
// (var/rt-history/, e.g. from npm run snapshot:pull).

import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  cumulativeLengths,
  distM,
  projectOnto,
  type LonLat,
} from "@transitopia/transit-core/geo.ts";
import { cadence } from "@transitopia/transit-core/rt/budget.ts";
import {
  Predictor,
  ProfileBuilder,
  type PredictionConfig,
  type RtProfileFile,
} from "@transitopia/transit-core/rt/profile.ts";
import { RtTimeline } from "@transitopia/transit-core/rt/timeline.ts";
import type { RtSnapshot } from "@transitopia/transit-core/rt/types.ts";
import { loadRecordedHours, planLoader } from "./lib/rt-history.ts";
import {
  log,
  readFeed,
  readFeedConfig,
  regionOfFeed,
  regionPaths,
} from "@transitopia/data/paths.ts";

// GPX rides so far are all on TransLink's buses.
const FEED = "translink";
const REGION = (await regionOfFeed(FEED)).id;
const rtConfig = (await readFeedConfig(FEED, REGION)).rt;
const CADENCE = cadence((await readFeed(FEED)).realtime!);
const GPX_DIR = join(regionPaths(REGION).observations, "gpx");
/** The live client keeps at least this much history per timeline (as eval-rt.ts). */
const HISTORY_MS = 10 * 60_000;
/** Ground truth is standing below this speed (m/s); GPS speed on a stopped phone is ~0.1–0.5. */
const STANDING_MPS = 1;
/** Stand-stills shorter than this aren't reported as stops (s). */
const MIN_STOP_S = 4;
/** A stand-still within this of a pattern stop's along-route position is at that stop (m). */
const AT_STOP_M = 40;
/**
 * GPS loggers (GPS.REC) record nothing while the phone stands still: a gap of at least this long (s)
 * spanning at most GAP_STAND_M is time standing at the earlier point.
 */
const GAP_STAND_S = 6;
const GAP_STAND_M = 15;
/** Live view sampling step (ms). */
const STEP_MS = 2000;

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const quiet = args.includes("--quiet");
const cfg: PredictionConfig = { ...rtConfig.prediction };
for (const kv of opt("--set")?.split(",") ?? []) {
  const [k, v] = kv.split("=");
  (cfg as unknown as Record<string, unknown>)[k!] = JSON.parse(v!);
}

interface GpxPoint {
  t: number;
  lon: number;
  lat: number;
  /** m/s as recorded, else derived. */
  speed: number;
}

function parseGpx(xml: string): GpxPoint[] {
  const pts: GpxPoint[] = [];
  for (const m of xml.matchAll(/<trkpt\b([^>]*)>([\s\S]*?)<\/trkpt>/g)) {
    const lat = Number(/lat="([^"]+)"/.exec(m[1]!)?.[1]);
    const lon = Number(/lon="([^"]+)"/.exec(m[1]!)?.[1]);
    const t = Date.parse(/<time>([^<]+)<\/time>/.exec(m[2]!)?.[1] ?? "");
    const s = /<speed>([^<]+)<\/speed>/.exec(m[2]!)?.[1];
    if (Number.isFinite(lat) && Number.isFinite(lon) && Number.isFinite(t))
      pts.push({ t, lon, lat, speed: s === undefined ? NaN : Number(s) });
  }
  pts.sort((a, b) => a.t - b.t);
  for (let i = 0; i < pts.length; i++)
    if (!Number.isFinite(pts[i]!.speed)) {
      const a = pts[Math.max(0, i - 1)]!;
      const b = pts[Math.min(pts.length - 1, i + 1)]!;
      pts[i]!.speed =
        b.t > a.t ?
          distM([a.lon, a.lat], [b.lon, b.lat]) / ((b.t - a.t) / 1000)
        : 0;
    }
  return pts;
}

/** Ground truth along one trip's shape: position, along-route distance and speed at any instant. */
class Truth {
  readonly pts: GpxPoint[];
  readonly along: number[];
  /** Per point: the bus stands there until the next point (a logging gap, or both points slow). */
  readonly standAfter: boolean[];
  private coords: LonLat[];
  private cum: Float64Array;

  constructor(pts: GpxPoint[], coords: LonLat[], cum: Float64Array) {
    this.pts = pts;
    this.coords = coords;
    this.cum = cum;
    // Monotone along-route distance: GPS noise on a standing bus mustn't move it backwards.
    let hint = 0;
    this.along = pts.map((p) => {
      const a = projectOnto(
        coords,
        cum,
        [p.lon, p.lat],
        Math.max(0, hint - 50),
      ).along;
      hint = Math.max(hint, a);
      return hint;
    });
    this.standAfter = pts.map((p, i) => {
      const n = pts[i + 1];
      if (!n) return false;
      if (p.speed < STANDING_MPS && n.speed < STANDING_MPS) return true;
      return (
        (n.t - p.t) / 1000 >= GAP_STAND_S
        && distM([p.lon, p.lat], [n.lon, n.lat]) <= GAP_STAND_M
      );
    });
  }

  get start(): number {
    return this.pts[0]!.t;
  }
  get end(): number {
    return this.pts.at(-1)!.t;
  }

  private index(t: number): [number, number] {
    let lo = 0;
    let hi = this.pts.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.pts[mid]!.t <= t) lo = mid;
      else hi = mid;
    }
    const a = this.pts[lo]!.t;
    const b = this.pts[hi]!.t;
    return [lo, b > a ? Math.min(1, Math.max(0, (t - a) / (b - a))) : 0];
  }

  at(t: number): { lonlat: LonLat; along: number; speed: number } {
    const [i, fRaw] = this.index(t);
    const p = this.pts[i]!;
    if (this.standAfter[i])
      return { lonlat: [p.lon, p.lat], along: this.along[i]!, speed: 0 };
    const f = fRaw;
    const q = this.pts[Math.min(i + 1, this.pts.length - 1)]!;
    return {
      lonlat: [p.lon + (q.lon - p.lon) * f, p.lat + (q.lat - p.lat) * f],
      along:
        this.along[i]!
        + (this.along[Math.min(i + 1, this.along.length - 1)]! - this.along[i]!)
          * f,
      speed: p.speed + (q.speed - p.speed) * f,
    };
  }

  /** First instant the bus reached `along`, or undefined outside the track. */
  timeAt(along: number): number | undefined {
    if (along < this.along[0]! || along > this.along.at(-1)!) return undefined;
    for (let i = 1; i < this.along.length; i++)
      if (this.along[i]! >= along) {
        const a0 = this.along[i - 1]!;
        const a1 = this.along[i]!;
        const f = a1 > a0 ? (along - a0) / (a1 - a0) : 0;
        return this.pts[i - 1]!.t + (this.pts[i]!.t - this.pts[i - 1]!.t) * f;
      }
    return undefined;
  }

  project(lonlat: LonLat, hint = 0): { along: number; offset: number } {
    return projectOnto(this.coords, this.cum, lonlat, hint);
  }
}

const q = (a: number[], f: number) => {
  if (!a.length) return NaN;
  const b = [...a].sort((x, y) => x - y);
  return b[Math.min(b.length - 1, Math.floor(f * b.length))]!;
};
const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
const n0 = (x: number) => (Number.isFinite(x) ? x.toFixed(0) : "–");
const dist = (a: number[], unit: string) =>
  a.length ?
    `p50 ${n0(q(a, 0.5)).padStart(4)} ${unit}  p75 ${n0(q(a, 0.75)).padStart(4)} ${unit}  p90 ${n0(q(a, 0.9)).padStart(4)} ${unit}  (n=${a.length})`
  : "(none)";

function clock(t: number, tz: string): string {
  return new Date(t).toLocaleTimeString("en-CA", {
    timeZone: tz,
    hour12: false,
  });
}

/** Results across files, for the summary. */
const totals = {
  fixLagS: [] as number[],
  fixCrossM: [] as number[],
  ageAtFetchS: [] as number[],
  live: {} as Record<string, number[]>,
  liveSigned: {} as Record<string, number[]>,
  playback: [] as number[],
};

async function evalFile(
  file: string,
  hoursAll: Awaited<ReturnType<typeof loadRecordedHours>>,
  plans: Awaited<ReturnType<typeof planLoader>>,
  profiles: Map<string, RtProfileFile>,
) {
  const name = basename(file, ".gpx");
  const m = /-B(\w+)-(\w+)$/.exec(name);
  const label = opt("--vehicle") ?? m?.[1];
  const tripId = opt("--trip") ?? m?.[2];
  if (!label || !tripId) {
    console.log(`\n${name}: no bus label or trip id in the name; skipped`);
    return;
  }
  const pts = parseGpx(await readFile(file, "utf8"));
  if (pts.length < 2) return;
  const pp = await plans.forTime(pts[0]!.t);
  const trip = pp?.tripIndex.get(tripId);
  const coords =
    trip && (pp?.plan.shapes[trip.pattern.shape] as LonLat[] | undefined);
  if (!pp || !trip || !coords) {
    console.log(`\n${name}: trip ${tripId} isn't in the plan; skipped`);
    return;
  }
  const tz = pp.plan.timezone;
  const cum = pp.shapeCum.get(trip.pattern.shape) ?? cumulativeLengths(coords);
  const truth = new Truth(pts, coords, cum);

  // Snapshots from HISTORY_MS before the ride to its end, and the profile from earlier days.
  const day = new Date(truth.start).toLocaleDateString("en-CA", {
    timeZone: tz,
  });
  const snaps = hoursAll
    .flatMap((h) => h.snapshots)
    .filter(
      (s) =>
        s.fetchedAt >= truth.start - HISTORY_MS
        && s.fetchedAt <= truth.end + 600_000,
    )
    .sort((a, b) => a.fetchedAt - b.fetchedAt);
  let profile = profiles.get(day);
  if (!profile) {
    const since = new Date(
      Date.parse(day) - rtConfig.prediction.profileHistoryDays * 86_400_000,
    )
      .toISOString()
      .slice(0, 10);
    const builder = new ProfileBuilder(pp, cfg);
    for (const h of hoursAll)
      if (!h.open && h.label < day && h.label >= since)
        builder.add(h.snapshots, h.label);
    profile = builder.build();
    profiles.set(day, profile);
  }
  const predictor = new Predictor(pp, cfg, profile);
  const course = predictor.course(trip, truth.start);

  const rideMin = (truth.end - truth.start) / 60_000;
  console.log(
    `\n=== ${name}: bus ${label}, trip ${tripId} (${trip.trip.headsign}), ${clock(truth.start, tz)}–${clock(truth.end, tz)} (${rideMin.toFixed(0)} min), ${pts.length} GPX points, ${snaps.length} snapshots`,
  );

  // ---- 1. Fixes vs truth ------------------------------------------------------------------
  const fixes = new Map<
    number,
    { v: RtSnapshot["vehicles"][number]; fetched: number }
  >();
  let vid: string | undefined;
  for (const s of snaps)
    for (const v of s.vehicles)
      if ((v.label === label || v.id === label) && v.tripId === tripId) {
        vid = v.id;
        if (!fixes.has(v.ts)) fixes.set(v.ts, { v, fetched: s.fetchedAt });
      }
  if (!vid) {
    console.log("  No GTFS-RT fixes for this bus and trip in var/rt-history/");
    return;
  }
  const rows: string[] = [];
  for (const { v, fetched } of [...fixes.values()].sort(
    (a, b) => a.v.ts - b.v.ts,
  )) {
    if (v.ts < truth.start || v.ts > truth.end) continue;
    const tr = truth.at(v.ts);
    const p = truth.project([v.lon, v.lat], Math.max(0, tr.along - 500));
    const tReal = truth.timeAt(p.along);
    const lag = tReal === undefined ? NaN : (v.ts - tReal) / 1000;
    const cross = distM([v.lon, v.lat], tr.lonlat);
    const age = (fetched - v.ts) / 1000;
    totals.fixCrossM.push(cross);
    if (Number.isFinite(lag)) totals.fixLagS.push(lag);
    totals.ageAtFetchS.push(age);
    rows.push(
      `    ${clock(v.ts, tz)}  ${n0(cross).padStart(5)} m  ${n0(p.along - tr.along).padStart(6)} m  ${n0(lag).padStart(5)} s  ${n0(age).padStart(5)} s  ${n0(p.offset).padStart(4)} m  ${(v.delay ?? NaN).toString().padStart(5)}  ${v.stopId ?? ""}`,
    );
  }
  const myLag = rows.length ? totals.fixLagS.slice(-rows.length) : [];
  console.log(
    `\n  1. GTFS-RT fixes vs ground truth (${rows.length} fixes during the ride)`,
  );
  if (!quiet) {
    console.log(
      "    fix time   to truth   along Δ   stale   age@fetch  off-shape  delay  stop",
    );
    for (const r of rows) console.log(r);
  }
  console.log(
    `    Staleness (fix timestamp − when the bus was really there): ${dist(myLag, "s")}; mean ${n0(mean(myLag))} s`,
  );

  // ---- 2. Where the bus stood -----------------------------------------------------------------
  const stops = trip.pattern.stops.map((si, i) => ({
    id: pp.plan.stops[si]!.id,
    name: pp.plan.stops[si]!.name,
    along: course.stops[i]!.along,
    expect: course.stops[i]!.dwell,
    actual: 0,
  }));
  const stands: { t0: number; t1: number; along: number }[] = [];
  let s0: number | undefined;
  for (let i = 0; i < pts.length; i++) {
    const standing = truth.standAfter[i]!;
    if (standing && s0 === undefined) s0 = i;
    if (!standing && s0 !== undefined) {
      // Standing from point s0 until point i.
      const t0 = pts[s0]!.t;
      const t1 = pts[i]!.t;
      if ((t1 - t0) / 1000 >= MIN_STOP_S)
        stands.push({ t0, t1, along: truth.along[s0]! });
      s0 = undefined;
    }
  }
  let atStops = 0;
  let elsewhere = 0;
  const elsewhereRows: string[] = [];
  for (const st of stands) {
    const d = (st.t1 - st.t0) / 1000;
    const near = stops.find((s) => Math.abs(s.along - st.along) <= AT_STOP_M);
    if (near) {
      near.actual += d;
      atStops += d;
    } else {
      elsewhere += d;
      elsewhereRows.push(
        `      ${clock(st.t0, tz)}  ${n0(d).padStart(4)} s  at ${n0(st.along)} m`,
      );
    }
  }
  // Only stops the ride covered (GPX may start after the first stop or end before the last).
  const covered = stops.filter(
    (s) => s.along > truth.along[0]! + 20 && s.along < truth.along.at(-1)! - 20,
  );
  const covAll = covered.filter((s) => s.expect > 0 || s.actual > 0);
  console.log(
    `\n  2. Standing still (< ${STANDING_MPS} m/s or a logging gap, for ≥ ${MIN_STOP_S} s): ${n0(atStops)} s at stops, ${n0(elsewhere)} s elsewhere, of ${n0(rideMin * 60)} s`,
  );
  if (!quiet) {
    console.log(
      "    stop                                              actual  profile",
    );
    for (const s of covAll)
      console.log(
        `    ${`${s.id} ${s.name}`.slice(0, 48).padEnd(48)}  ${n0(s.actual).padStart(5)} s  ${n0(s.expect).padStart(5)} s`,
      );
    if (elsewhereRows.length) {
      console.log("    elsewhere (signals, traffic):");
      for (const r of elsewhereRows) console.log(r);
    }
  }
  const dwellErr = covAll.map((s) => s.expect - s.actual);
  console.log(
    `    Profile dwell − actual, per stop: mean ${n0(mean(dwellErr))} s, |err| ${dist(dwellErr.map(Math.abs), "s")}; skipped stops (no stand-still): ${covered.filter((s) => s.actual === 0).length} of ${covered.length}`,
  );
  const a0 = truth.along[0]!;
  const a1 = truth.along.at(-1)!;
  const tProfile = predictor.timeBetween(course, a0, a1);
  console.log(
    `    Ride time over ${n0(a1 - a0)} m: actual ${n0((truth.end - truth.start) / 1000)} s, profile ${n0(tProfile)} s`,
  );

  // ---- 3. Live view vs truth ------------------------------------------------------------------
  const base = {
    maxInterpolateS: CADENCE.maxInterpolateS,
    maxExtrapolateS: CADENCE.maxExtrapolateS,
    source: "eval",
  };
  const variants = {
    old: base,
    new: { ...base, prediction: { cfg, predictor } },
  };
  const ageBands: [string, number][] = [
    ["< 60 s", 60],
    ["60–120 s", 120],
    ["120–180 s", 180],
    ["180–300 s", 300],
    ["≥ 300 s", Infinity],
  ];
  console.log(
    "\n  3. Live view vs ground truth (every 2 s; error along the route)",
  );
  for (const [vname, opts] of Object.entries(variants)) {
    const all: number[] = [];
    const signed: number[] = [];
    const byAge = new Map<string, number[]>();
    const moving: number[] = [];
    const standing: number[] = [];
    let missing = 0;
    let k = -1;
    let tl: RtTimeline | undefined;
    for (let t = truth.start; t <= truth.end; t += STEP_MS) {
      let kk = k;
      while (kk + 1 < snaps.length && snaps[kk + 1]!.fetchedAt <= t) kk++;
      if (kk < 0) continue;
      if (kk !== k) {
        k = kk;
        let j = k;
        while (
          j > 0
          && snaps[k]!.fetchedAt - snaps[j - 1]!.fetchedAt < HISTORY_MS
        )
          j--;
        tl = new RtTimeline(snaps.slice(j, k + 1), pp, plans.kin, opts);
      }
      const v = tl!.vehiclesAt(t).find((x) => x.id === `rt:${vid}`);
      const tr = truth.at(t);
      if (!v || v.tripId !== tripId) {
        missing++;
        continue;
      }
      const along = truth.project(
        [v.lon, v.lat],
        Math.max(0, tr.along - 1000),
      ).along;
      const e = along - tr.along;
      all.push(Math.abs(e));
      signed.push(e);
      (tr.speed < STANDING_MPS ? standing : moving).push(Math.abs(e));
      const lastFix = [...fixes.keys()]
        .filter((ts) => ts <= snaps[k]!.fetchedAt)
        .at(-1);
      const age = lastFix === undefined ? Infinity : (t - lastFix) / 1000;
      const band = ageBands.find(([, hi]) => age < hi)![0];
      (byAge.get(band) ?? byAge.set(band, []).get(band)!).push(Math.abs(e));
    }
    (totals.live[vname] ??= []).push(...all);
    (totals.liveSigned[vname] ??= []).push(...signed);
    console.log(
      `    ${vname.padEnd(4)} ${dist(all, "m")}; bias ${n0(mean(signed))} m (+ ahead); not shown ${n0((missing * STEP_MS) / 1000)} s`,
    );
    if (!quiet) {
      console.log(
        `         bus moving ${dist(moving, "m")}\n         standing   ${dist(standing, "m")}`,
      );
      for (const [b] of ageBands)
        if (byAge.get(b)?.length)
          console.log(
            `         fix ${b.padEnd(9)} old  ${dist(byAge.get(b)!, "m")}`,
          );
    }
  }

  // ---- 4. Recorded playback vs truth ----------------------------------------------------------
  const full = new RtTimeline(snaps, pp, plans.kin, variants.new);
  const pb: number[] = [];
  for (let t = truth.start; t <= truth.end; t += STEP_MS) {
    const v = full.vehiclesAt(t).find((x) => x.id === `rt:${vid}`);
    if (!v || v.tripId !== tripId) continue;
    const tr = truth.at(t);
    pb.push(
      Math.abs(
        truth.project([v.lon, v.lat], Math.max(0, tr.along - 1000)).along
          - tr.along,
      ),
    );
  }
  totals.playback.push(...pb);
  console.log(`\n  4. Recorded playback vs ground truth: ${dist(pb, "m")}`);
}

async function main() {
  const files =
    args.filter((a) => a.endsWith(".gpx")).length ?
      args.filter((a) => a.endsWith(".gpx"))
    : (await readdir(GPX_DIR))
        .filter((f) => /-B\w+-\w+\.gpx$/.test(f))
        .sort()
        .map((f) => join(GPX_DIR, f));
  if (!files.length) throw new Error(`No GPX files (looked in ${GPX_DIR})`);
  const hours = await loadRecordedHours(FEED);
  const plans = await planLoader(FEED);
  const profiles = new Map<string, RtProfileFile>();
  log(`${files.length} GPX file(s), ${hours.length} recorded hours`);
  for (const f of files) await evalFile(f, hours, plans, profiles);
  if (files.length > 1) {
    console.log("\n=== All rides");
    console.log(
      `  Fix staleness  ${dist(totals.fixLagS, "s")}; mean ${n0(mean(totals.fixLagS))} s`,
    );
    console.log(`  Fix to truth   ${dist(totals.fixCrossM, "m")}`);
    console.log(`  Age at fetch   ${dist(totals.ageAtFetchS, "s")}`);
    for (const [k, a] of Object.entries(totals.live))
      console.log(
        `  Live ${k.padEnd(4)}      ${dist(a, "m")}; bias ${n0(mean(totals.liveSigned[k]!))} m`,
      );
    console.log(`  Playback       ${dist(totals.playback, "m")}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
