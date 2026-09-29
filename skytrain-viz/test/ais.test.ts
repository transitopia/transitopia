import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aisCorrections, schedTimeAt, type AisFix, type AisMatchConfig } from '../src/core/ais/match.ts';
import { decodeFixes, encodeFixes, fixToVehicle, parseAisMessage, parseAisTime, vehicleToFix } from '../src/core/ais/fixes.ts';
import { preparePlan, scheduledVehicles } from '../src/core/schedule/engine.ts';
import { distM } from '../src/core/geo.ts';
import { serviceDayStart } from '../src/core/time.ts';
import type { ServicePlan } from '../src/core/plan/types.ts';
import type { KinematicsConfig } from '../src/core/movement/kinematics.ts';
import { AisFeed } from '../server/rt/ais.ts';
import { Recorder } from '../server/rt/recorder.ts';

const kin: KinematicsConfig = {
  modes: { ferry: { accel: 0.08, decel: 0.08, maxSpeed: 24, minCruiseFraction: 0.6, dwell: 0, length: 34, width: 10, profile: 'trapezoid' } },
  routes: {},
  sizing: { minPixelLength: 14, minPixelWidth: 6 },
};

// A 2.2 km crossing due north; one vessel (block b1) shuttling every 15 min with 12-minute crossings
// and 3-minute layovers from 08:00 (28800 s).
const S: [number, number] = [-123.1, 49.28];
const N: [number, number] = [-123.1, 49.29978];
const plan: ServicePlan = {
  schema: 1,
  feedVersion: 'test',
  feedStart: '20260901',
  feedEnd: '20261231',
  timezone: 'America/Vancouver',
  builtAt: '',
  routes: [{ key: 'seabus', label: 'SeaBus', kind: 'shape', mode: 'ferry', color: '#000', textColor: '#fff', gtfsRouteId: '1' }],
  stops: [
    { id: 'S', name: 'South', lon: S[0], lat: S[1] },
    { id: 'N', name: 'North', lon: N[0], lat: N[1] },
  ],
  stations: [],
  shapes: { north: [S, N], south: [N, S] },
  patterns: [
    { id: 0, route: 'seabus', direction: 0, shape: 'north', stops: [0, 1], dist: [0, 2200] },
    { id: 1, route: 'seabus', direction: 1, shape: 'south', stops: [1, 0], dist: [0, 2200] },
  ],
  trips: [0, 1, 2, 3].map((i) => ({ id: `t${i}`, pattern: i % 2, service: 'wk', block: 'b1', headsign: '', start: 28800 + i * 900, arr: [0, 720] })),
  calendar: { calendar: [{ serviceId: 'wk', days: [true, true, true, true, true, false, false], start: '20260901', end: '20261231' }], exceptions: [] },
};
const pp = preparePlan(plan, kin);
const DATE = '20260928';
const day = serviceDayStart(DATE);
const cfg: AisMatchConfig = { maxOffsetM: 200, maxShiftS: 600, stationaryKn: 0.5, dockRadiusM: 40, courseToleranceDeg: 60, minTurnaroundS: 90, maxCarryTrips: 3 };
const at = (sec: number) => day + sec * 1000;
const lerp = (f: number): [number, number] => [S[0], S[1] + (N[1] - S[1]) * f];
const fix = (sec: number, f: number, extra: Partial<AisFix> = {}): AisFix => {
  const [lon, lat] = lerp(f);
  return { mmsi: '316042365', name: 'BURRARD CHINOOK', ts: at(sec), lat, lon, sog: 11, cog: 0, ...extra };
};

describe('parseAisMessage', () => {
  const msg = {
    MessageType: 'PositionReport',
    MetaData: { MMSI: 316028554, ShipName: 'BURRARD OTTER II    ', latitude: 49.30374, longitude: -123.08787, time_utc: '2026-09-29 02:09:16.130641461 +0000 UTC' },
    Message: { PositionReport: { Sog: 12.7, Cog: 25, TrueHeading: 26, Latitude: 49.30374, Longitude: -123.08787, Valid: true } },
  };
  it('reads a position report for a tracked vessel', () => {
    expect(parseAisMessage(msg, new Set(['316028554']))).toEqual({ mmsi: '316028554', name: 'BURRARD OTTER II', ts: Date.parse('2026-09-29T02:09:16.130Z'), lat: 49.30374, lon: -123.08787, sog: 12.7, cog: 25 });
  });
  it('ignores other vessels, other message types and "not available" values', () => {
    expect(parseAisMessage(msg, new Set(['1']))).toBeUndefined();
    expect(parseAisMessage({ ...msg, MessageType: 'ShipStaticData' }, new Set(['316028554']))).toBeUndefined();
    const na = { ...msg, Message: { PositionReport: { ...msg.Message.PositionReport, Sog: 102.3, Cog: 360 } } };
    const f = parseAisMessage(na, new Set(['316028554']))!;
    expect(f.sog).toBeUndefined();
    expect(f.cog).toBeUndefined();
    expect(parseAisTime('garbage')).toBeUndefined();
  });
  it('round-trips through the recorder and wire formats', () => {
    const f = parseAisMessage(msg, new Set(['316028554']))!;
    expect(vehicleToFix(fixToVehicle(f, 'seabus'))).toEqual(f);
    expect(decodeFixes(encodeFixes([f]))).toEqual([f]);
  });
});

describe('aisCorrections', () => {
  it('anchors a crossing to a fix and names the vessel for its block', () => {
    // t1 departs North at 08:15 heading south; seen halfway across 2 min late.
    const t1Half = schedTimeAt(pp.tripIndex.get('t1')!, 1100);
    const r = aisCorrections(pp, DATE, [fix(t1Half + 120, 0.5, { cog: 180 })], 'seabus', cfg);
    expect(r.matched).toBe(1);
    const c = r.corrections.trips.get('t1')!;
    expect(c.anchors).toHaveLength(1);
    expect(c.anchors[0]!.shift).toBeGreaterThan(100);
    expect(c.anchors[0]!.shift).toBeLessThan(140);
    expect(c.observed).toHaveLength(1);
    expect(r.corrections.consists.get('seabus:wk:b1')).toEqual({ name: 'BURRARD CHINOOK' });
    // Lateness carries into the next trip, less the layover beyond the minimum turnaround (180 − 90 s).
    const t2 = r.corrections.trips.get('t2')!;
    expect(t2.estimate).toMatch(/AIS/);
    expect(t2.anchors[0]!.shift).toBeCloseTo(c.anchors[0]!.shift - 90, 0);

    // The engine draws the vessel at the fix, observed.
    const v = scheduledVehicles(pp, { serviceDate: DATE, sec: t1Half + 120 }, r.corrections);
    expect(v).toHaveLength(1);
    expect(v[0]!.provenance).toBe('observed');
    expect(distM([v[0]!.lon, v[0]!.lat], lerp(0.5))).toBeLessThan(15);
    expect(v[0]!.consist?.name).toBe('BURRARD CHINOOK');
  });

  it('uses course to tell the directions apart', () => {
    // At 08:12 t0 (northbound) is arriving at North; t1 (southbound) hasn't left. A vessel near North
    // heading south must be t1, running early.
    const r = aisCorrections(pp, DATE, [fix(28800 + 700, 0.97, { cog: 180 })], 'seabus', cfg);
    expect([...r.corrections.trips.keys()]).toEqual(['t1']);
  });

  it('treats a docked vessel as late only once it misses its departure', () => {
    const dock = (sec: number) => fix(sec, 1, { sog: 0 });
    // Docked at North at 08:14: consistent with the timetable (t1 leaves 08:15).
    const onTime = aisCorrections(pp, DATE, [dock(28800 + 840)], 'seabus', cfg);
    expect(onTime.corrections.trips.get('t1')!.anchors).toEqual([{ sched: 28800 + 900, shift: 0 }]);
    // Still docked at 08:17: t1 is at least 2 min late.
    const late = aisCorrections(pp, DATE, [dock(28800 + 1020)], 'seabus', cfg);
    expect(late.corrections.trips.get('t1')!.anchors).toEqual([{ sched: 28800 + 900, shift: 120 }]);
  });

  it('ignores vessels away from the route (layup berth) and outside service', () => {
    const r = aisCorrections(pp, DATE, [
      { mmsi: '316011649', ts: at(29000), lat: 49.31, lon: -123.12, sog: 0 },
      fix(20000, 0.5),
    ], 'seabus', cfg);
    expect(r.matched).toBe(0);
    expect(r.unmatched).toBe(2);
    expect(r.corrections.trips.size).toBe(0);
  });
});

describe('AisFeed', () => {
  it('subscribes, collects fixes, records batches and serves them by service date with a cursor', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ais-'));
    try {
      const listeners: Record<string, ((ev: any) => void)[]> = {};
      const sent: string[] = [];
      const socket = {
        send: (s: string) => sent.push(s),
        close: () => {},
        addEventListener: (type: string, fn: (ev: any) => void) => (listeners[type] ??= []).push(fn),
      };
      const emit = (type: string, ev: any = {}) => listeners[type]?.forEach((fn) => fn(ev));
      const recorder = new Recorder(dir, 75_000);
      const feed = new AisFeed({
        apiKey: 'k',
        cfg: { vessels: [{ mmsi: '316042365', name: 'Burrard Chinook' }], boundingBox: [[49.27, -123.14], [49.33, -123.05]], batchS: 3600, maxBackoffS: 60 },
        route: 'seabus',
        recorder,
        log: () => {},
        connect: () => socket as any,
      });
      await feed.start();
      emit('open');
      expect(JSON.parse(sent[0]!)).toMatchObject({ APIKey: 'k', FiltersShipMMSI: ['316042365'] });
      emit('message', { data: JSON.stringify({ MessageType: 'SubscriptionConfirmation' }) });
      expect(feed.status().connected).toBe(true);
      const now = new Date();
      const utc = now.toISOString().replace('T', ' ').replace('Z', '') + ' +0000 UTC';
      emit('message', { data: JSON.stringify({ MessageType: 'PositionReport', MetaData: { MMSI: 316042365, ShipName: 'BURRARD CHINOOK', latitude: 49.29, longitude: -123.1, time_utc: utc }, Message: { PositionReport: { Sog: 11, Cog: 30 } } }) });
      await new Promise((r) => setTimeout(r, 10));
      const { localDate } = await import('../src/core/time.ts');
      // Before 03:00 local, fixes belong to the previous service date.
      const w = (await import('../src/core/time.ts')).toWallTime(now.getTime());
      const date = w.hour < 3 ? (await import('../src/core/time.ts')).addDays(localDate(now.getTime()), -1) : localDate(now.getTime());
      const all = await feed.fixesFor(date);
      expect(all.fixes).toHaveLength(1);
      expect((await feed.fixesFor(date, all.cursor)).fixes).toHaveLength(0);
      await (feed as any).flush();
      feed.stop();
      // A restarted feed resumes the recorded fix.
      const again = new AisFeed({ apiKey: 'k', cfg: (feed as any).opts.cfg, route: 'seabus', recorder: new Recorder(dir, 75_000), log: () => {}, connect: () => socket as any });
      await again.start();
      expect((await again.fixesFor(date)).fixes.map((f) => f.mmsi)).toEqual(['316042365']);
      again.stop();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
