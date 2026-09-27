import { describe, expect, it } from 'vitest';
import { coverageContains, decodeSnapshot, encodeSnapshot, extendCoverage, type RtSnapshot } from '../src/core/rt/types.ts';
import { RtTimeline } from '../src/core/rt/timeline.ts';
import { Predictor, ProfileBuilder, type PredictionConfig } from '../src/core/rt/profile.ts';
import { cumulativeLengths, pointAlong, projectOnto, type LonLat } from '../src/core/geo.ts';
import rtConfig from '../data/config/rt.json';
import { delayCorrections } from '../src/core/rt/carry.ts';
import { preparePlan, scheduledVehicles } from '../src/core/schedule/engine.ts';
import type { ServicePlan } from '../src/core/plan/types.ts';
import type { KinematicsConfig } from '../src/core/movement/kinematics.ts';

const kin: KinematicsConfig = {
  modes: { bus: { accel: 1, decel: 1, maxSpeed: 60, minCruiseFraction: 0, dwell: 0, length: 18, width: 2.6, profile: 'linear' } },
  routes: {},
  sizing: { minPixelLength: 14, minPixelWidth: 6 },
};

// An L-shaped bus route: 1 km east, then 1 km north. Straight-line interpolation between fixes on
// either side of the corner would cut the corner; along-shape interpolation must not.
const corner: [number, number] = [-123.08625, 49.25];
const plan: ServicePlan = {
  schema: 1,
  feedVersion: 't',
  feedStart: '20260901',
  feedEnd: '20261231',
  timezone: 'America/Vancouver',
  builtAt: '',
  routes: [{ key: '99', label: '99', kind: 'bus', mode: 'bus', color: '#f76707', textColor: '#fff', gtfsRouteId: '6641' }],
  stops: [
    { id: 's1', name: 'Start', lon: -123.1, lat: 49.25 },
    { id: 's2', name: 'End', lon: corner[0], lat: 49.259 },
  ],
  stations: [],
  shapes: { L: [[-123.1, 49.25], corner, [corner[0], 49.259]] },
  patterns: [{ id: 0, route: '99', direction: 0, shape: 'L', stops: [0, 1], dist: [0, 2000] }],
  trips: [{ id: 'trip1', pattern: 0, service: 'wk', headsign: 'To End', start: 30000, arr: [0, 400] }],
  calendar: { calendar: [], exceptions: [] },
};
const pp = preparePlan(plan, kin);

const T0 = Date.UTC(2026, 8, 28, 16, 0, 0);
function snap(offsetS: number, vehicles: [number, number][], id = 'bus1'): RtSnapshot {
  return {
    fetchedAt: T0 + offsetS * 1000 + 3000,
    headerTs: T0 + offsetS * 1000,
    vehicles: vehicles.map(([lon, lat]) => ({ id, routeKey: '99', tripId: 'trip1', lon, lat, ts: T0 + offsetS * 1000, label: '23005' })),
  };
}
const opts = { maxInterpolateS: 180, maxExtrapolateS: 90, source: 'test' };

describe('RtTimeline', () => {
  // Fix 1: 200 m before the corner; fix 2: 200 m after it, 60 s later.
  const before: [number, number] = [corner[0] - 0.00275, 49.25];
  const after: [number, number] = [corner[0], 49.25 + 0.0018];
  const tl = new RtTimeline([snap(0, [before]), snap(60, [after])], pp, kin, opts);

  it('interpolates along the shape, through the corner', () => {
    const [v] = tl.vehiclesAt(T0 + 30_000);
    expect(v?.provenance).toBe('interpolated');
    expect(v?.lon).toBeCloseTo(corner[0], 4);
    expect(v?.lat).toBeCloseTo(corner[1], 4);
    expect(v?.label).toBe('23005');
    expect(v?.id).toBe('rt:bus1');
  });
  it('shows nothing before the first fix', () => {
    expect(tl.vehiclesAt(T0 - 1000)).toHaveLength(0);
  });
  it('dead-reckons along the shape after the last fix, then gives up', () => {
    expect(tl.vehiclesAt(T0 + 65_000)[0]?.provenance).toBe('observed');
    const [v] = tl.vehiclesAt(T0 + 90_000);
    // 30 s past the fix is a prediction, not an observation.
    expect(v?.provenance).toBe('interpolated');
    expect(v?.lat).toBeGreaterThan(after[1]);
    expect(v?.lon).toBeCloseTo(corner[0], 5);
    expect(tl.vehiclesAt(T0 + 60_000 + 91_000)).toHaveLength(0);
  });
  it('hides a vehicle once a later snapshot no longer includes it', () => {
    const gone = new RtTimeline([snap(0, [before]), snap(20, [], 'bus1')], pp, kin, opts);
    expect(gone.vehiclesAt(T0 + 10_000)).toHaveLength(1);
    expect(gone.vehiclesAt(T0 + 30_000)).toHaveLength(0);
  });
  it('does not interpolate across long gaps', () => {
    const gap = new RtTimeline([snap(0, [before]), snap(600, [after])], pp, kin, opts);
    expect(gap.vehiclesAt(T0 + 300_000)).toHaveLength(0);
  });
  it('filters by route', () => {
    expect(tl.vehiclesAt(T0 + 30_000, new Set(['R4']))).toHaveLength(0);
  });
});

describe('prediction', () => {
  const cfg = rtConfig.prediction as unknown as PredictionConfig;
  const L = plan.shapes.L as LonLat[];
  const cum = cumulativeLengths(L);
  const at = (along: number): [number, number] => {
    const p = pointAlong(L, cum, along);
    return [p.lon, p.lat];
  };
  const alongOf = (v: { lon: number; lat: number }) => projectOnto(L, cum, [v.lon, v.lat]).along;
  const predictor = new Predictor(pp, cfg);
  const popts = { ...opts, prediction: { cfg, predictor } };

  it('stops at an upcoming stop for its dwell, then leaves', () => {
    // A mid-route stop at 1000 m with a 30 s dwell, via a learned profile.
    const withStop = { ...plan, stops: [...plan.stops, { id: 'mid', name: 'Mid', lon: at(1000)[0], lat: at(1000)[1] }] };
    withStop.patterns = [{ ...plan.patterns[0]!, stops: [0, 2, 1], dist: [0, 1000, 2000] }];
    withStop.trips = [{ ...plan.trips[0]!, arr: [0, 200, 400] }];
    const pp2 = preparePlan(withStop, kin);
    const profile = new ProfileBuilder(pp2, cfg).build();
    profile.shapes.L = { bands: [], all: { pace: Array(40).fill(0.1), dwell: { mid: 30 } } };
    const p = new Predictor(pp2, cfg, profile);
    const c = p.course(pp2.tripIndex.get('trip1')!, T0);
    expect(p.walk(c, 900, 5).along).toBeCloseTo(950, 5); // 10 m/s
    expect(p.walk(c, 900, 20)).toEqual({ along: 1000, speed: 0 }); // arrived at 10 s, dwelling
    expect(p.walk(c, 900, 45).along).toBeCloseTo(1050, 5); // left at 40 s
    // Already past the stop: no dwell.
    expect(p.walk(c, 1000, 5).along).toBeCloseTo(1050, 5);
  });

  it('paces schedule estimates between timetable times, stopping at stops', () => {
    // Stop at 1000 m, due at 200 s; the timetable gives no dwell, the default dwell (15 s) applies.
    const withStop = { ...plan, stops: [...plan.stops, { id: 'mid', name: 'Mid', lon: at(1000)[0], lat: at(1000)[1] }] };
    withStop.patterns = [{ ...plan.patterns[0]!, stops: [0, 2, 1], dist: [0, 1000, 2000] }];
    withStop.trips = [{ ...plan.trips[0]!, arr: [0, 200, 400] }];
    withStop.calendar = { calendar: [{ serviceId: 'wk', days: [true, true, true, true, true, true, true], start: '20260901', end: '20261231' }], exceptions: [] };
    const pp2 = preparePlan(withStop, kin);
    const p = new Predictor(pp2, cfg);
    const trip = pp2.tripIndex.get('trip1')!;
    const start = trip.trip.start;
    const moving = p.pacer(trip, start + 100, '20260928')!;
    expect(moving.speed).toBeGreaterThan(0);
    // Arrives a little early and waits: standing at the stop until its timetable time.
    expect(p.pacer(trip, start + 192, '20260928')).toEqual({ along: 1000, speed: 0 });
    expect(p.pacer(trip, start + 199, '20260928')).toEqual({ along: 1000, speed: 0 });
    expect(p.pacer(trip, start + 210, '20260928')!.along).toBeGreaterThan(1000);
    // And the schedule engine uses it: dwelling at the stop.
    const [v] = scheduledVehicles(pp2, { serviceDate: '20260928', sec: start + 195, pacer: p.pacer });
    expect(v?.status).toBe('dwell');
    expect(v?.stopName).toBe('Mid');
  });

  // Fix A at 200 m (t=0), fix B 30 s later; each known from its snapshot's fetch (3 s after).
  const showAt = (fixB: number, t: number) => {
    const withB = new RtTimeline([snap(0, [at(200)]), snap(30, [at(fixB)])], pp, kin, popts);
    return withB.vehiclesAt(T0 + t * 1000)[0]!;
  };
  const shownBeforeB = (t: number) => new RtTimeline([snap(0, [at(200)])], pp, kin, popts).vehiclesAt(T0 + t * 1000)[0]!;

  it('glides forward to a fix that is further ahead than predicted, without jumping', () => {
    const before = alongOf(shownBeforeB(33));
    expect(alongOf(showAt(600, 33))).toBeCloseTo(before, 0);
    let last = before;
    for (let t = 34; t <= 60; t++) {
      const a = alongOf(showAt(600, t));
      expect(a).toBeGreaterThanOrEqual(last - 1e-6);
      last = a;
    }
    // Caught up with the prediction from B once the glide is over.
    const raw = new RtTimeline([snap(30, [at(600)])], pp, kin, popts);
    expect(alongOf(showAt(600, 62))).toBeCloseTo(alongOf(raw.vehiclesAt(T0 + 62_000)[0]!), 0);
  });

  it('holds still when a fix is behind the prediction, rather than going backwards', () => {
    const before = alongOf(shownBeforeB(33));
    expect(alongOf(showAt(250, 33))).toBeCloseTo(before, 0);
    expect(alongOf(showAt(250, 43))).toBeCloseTo(before, 0);
    expect(showAt(250, 43).status).toBe('dwell');
    expect(alongOf(showAt(250, 80))).toBeGreaterThan(before + 50);
  });

  it('discards impossible fixes', () => {
    const bad = new RtTimeline([snap(0, [at(200)]), snap(30, [[0, 0]]), snap(60, [at(500)])], pp, kin, opts);
    const [v] = bad.vehiclesAt(T0 + 45_000);
    expect(alongOf(v!)).toBeGreaterThan(200);
    expect(alongOf(v!)).toBeLessThan(500);
  });
});

describe('carrying RT delays into schedule estimates', () => {
  const cfg = rtConfig.prediction as unknown as PredictionConfig;
  const L = plan.shapes.L as LonLat[];
  const cum = cumulativeLengths(L);
  const at = (along: number): [number, number] => {
    const p = pointAlong(L, cum, along);
    return [p.lon, p.lat];
  };
  const alongOf = (v: { lon: number; lat: number }) => projectOnto(L, cum, [v.lon, v.lat]).along;
  // trip1 08:20:00–08:26:40 out, trip2 back from 08:30:00 (same block, 200 s layover).
  const T = 30000;
  const cal = { calendar: [{ serviceId: 'wk', days: [true, true, true, true, true, true, true], start: '20260901', end: '20261231' }], exceptions: [] };
  const two: ServicePlan = {
    ...plan,
    shapes: { ...plan.shapes, R: [...L].reverse() },
    patterns: [plan.patterns[0]!, { id: 1, route: '99', direction: 1, shape: 'R', stops: [1, 0], dist: [0, 2000] }],
    trips: [
      { id: 'trip1', pattern: 0, service: 'wk', block: 'b1', headsign: 'To End', start: T, arr: [0, 400] },
      { id: 'trip2', pattern: 1, service: 'wk', block: 'b1', headsign: 'To Start', start: T + 600, arr: [0, 400] },
    ],
    calendar: cal,
  };
  const pp2 = preparePlan(two, kin);
  const predictor = new Predictor(pp2, cfg);
  const date = '20260928';
  const day0 = Date.UTC(2026, 8, 28, 7, 0, 0); // service day start (00:00 PDT)
  // Bus seen at 200 m, 5 min late (scheduled there at T + 38.5 s).
  const fixTs = day0 + (T + 38.5 + 300) * 1000;
  const snapAt = (ts: number, along: number): RtSnapshot => ({
    fetchedAt: ts + 3000,
    headerTs: ts,
    vehicles: [{ id: 'bus1', routeKey: '99', tripId: 'trip1', lon: at(along)[0], lat: at(along)[1], ts }],
  });
  const tl = new RtTimeline([snapAt(fixTs, 200)], pp2, kin, { ...opts, prediction: { cfg, predictor } });
  const delays = tl.tripDelays(fixTs + 1000);
  const carry = delayCorrections(pp2, delays, rtConfig.carry);

  it('measures the delay against the paced schedule', () => {
    expect(delays).toHaveLength(1);
    expect(delays[0]!.serviceDate).toBe(date);
    expect(delays[0]!.delay).toBeCloseTo(300, 0);
  });

  it('takes over from exactly where RT prediction leaves the bus', () => {
    const handover = fixTs + opts.maxExtrapolateS * 1000;
    const rtAlong = alongOf(tl.vehiclesAt(handover)[0]!);
    expect(tl.vehiclesAt(handover + 1000)).toHaveLength(0);
    const [est] = scheduledVehicles(pp2, { serviceDate: date, sec: (handover - day0) / 1000, pacer: predictor.pacer }, carry.byDate.get(date));
    expect(est?.provenance).toBe('estimated');
    expect(est?.delay).toBe(300);
    expect(alongOf(est!)).toBeCloseTo(rtAlong, 0);
    // And keeps going.
    const [later] = scheduledVehicles(pp2, { serviceDate: date, sec: (handover - day0) / 1000 + 60, pacer: predictor.pacer }, carry.byDate.get(date));
    expect(alongOf(later!)).toBeGreaterThan(rtAlong + 100);
  });

  it('carries lateness into the next trip, less the layover slack', () => {
    // 300 s late; layover 200 s, of which 200 - 120 = 80 s is slack: trip2 leaves 220 s late.
    expect(carry.carried).toEqual(new Set(['trip1', 'trip2']));
    expect(carry.byDate.get(date)!.trips.get('trip2')!.anchors[0]!.shift).toBeCloseTo(220, 0);
    // Early running doesn't carry.
    const early = delayCorrections(pp2, [{ ...delays[0]!, delay: -120 }], rtConfig.carry);
    expect([...early.carried]).toEqual(['trip1']);
  });
});

describe('shifted GPS', () => {
  const cfg = rtConfig.prediction as unknown as PredictionConfig;
  const L = plan.shapes.L as LonLat[];
  const cum = cumulativeLengths(L);
  const alongOf = (v: { lon: number; lat: number }) => projectOnto(L, cum, [v.lon, v.lat]).along;
  // A point `along` the first (eastward) leg, shifted `north` metres.
  const pt = (along: number, north = 0): [number, number] => {
    const p = pointAlong(L, cum, along);
    return [p.lon, p.lat + north / 111_320];
  };
  const fix = (s: number, [lon, lat]: [number, number]): RtSnapshot => ({
    fetchedAt: T0 + s * 1000 + 3000,
    headerTs: T0 + s * 1000,
    vehicles: [{ id: 'bus1', routeKey: '99', tripId: 'trip1', lon, lat, ts: T0 + s * 1000, stopId: 's1', delay: 1800 }],
  });
  const popts = { ...opts, prediction: { cfg, predictor: new Predictor(pp, cfg) } };

  it('places a bus reported ~500 m off its route, still progressing along it, on the route', () => {
    const tl = new RtTimeline([fix(0, pt(100)), fix(30, pt(250, 500)), fix(60, pt(400, 500))], pp, kin, popts);
    const v = tl.vehiclesAt(T0 + 30_000)[0]!;
    expect(alongOf(v)).toBeCloseTo(250, 0);
    expect(v.lat).toBeCloseTo(49.25, 5); // on the route, not 500 m north
    expect(v.provenance).toBe('interpolated');
    expect(v.note).toMatch(/offset ≈ 500 m north/);
    // TransLink's next stop (the first stop, 250 m back) is stuck: use the position instead.
    expect(v.stopName).toBe('End');
    expect(v.note).toMatch(/stuck at Start/);
    expect(Math.abs(v.delay! - 1800)).toBeGreaterThan(60);
  });

  it('leaves a far-off fix alone when it does not fit how the bus is progressing', () => {
    // 400 m backwards along the route in 30 s: not the same bus progressing; shown where reported.
    const tl = new RtTimeline([fix(0, pt(900)), fix(30, pt(500, 500))], pp, kin, popts);
    const v = tl.vehiclesAt(T0 + 30_000)[0]!;
    expect(v.lat).toBeCloseTo(49.25 + 500 / 111_320, 5);
    expect(v.note).toMatch(/Not on its route \(≈ 500 m away\)/);
    expect(v.delay).toBeUndefined();
  });
});

describe('snapshot encoding', () => {
  it('round-trips compactly', () => {
    const s = snap(0, [[-123.123456789, 49.2]]);
    s.vehicles[0]!.delay = -180;
    s.vehicles[0]!.status = 2;
    const d = decodeSnapshot(encodeSnapshot(s));
    expect(d.fetchedAt).toBe(s.fetchedAt);
    expect(d.vehicles[0]).toMatchObject({ id: 'bus1', routeKey: '99', tripId: 'trip1', delay: -180, status: 2, label: '23005' });
    expect(d.vehicles[0]!.lon).toBeCloseTo(-123.12346, 5);
    expect(d.vehicles[0]!.bearing).toBeUndefined();
  });
});

describe('coverage', () => {
  it('merges points within the gap and splits beyond it', () => {
    const iv: [number, number][] = [];
    for (const t of [0, 20, 40, 60]) extendCoverage(iv, t * 1000, 75_000);
    extendCoverage(iv, 300_000, 75_000);
    expect(iv).toEqual([
      [0, 60_000],
      [300_000, 300_000],
    ]);
    expect(coverageContains(iv, 30_000)).toBe(true);
    expect(coverageContains(iv, 200_000)).toBe(false);
    expect(coverageContains(iv, 200_000, 100_000)).toBe(true);
  });
  it('handles out-of-order points', () => {
    const iv: [number, number][] = [[100_000, 200_000]];
    extendCoverage(iv, 50_000, 75_000);
    expect(iv).toEqual([[50_000, 200_000]]);
  });
});
