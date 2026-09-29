import { describe, expect, it } from 'vitest';
import rtConfig from '../data/config/rt.json' with { type: 'json' };
import { bandAt, cadence, maxRequestsPer24h, pollIntervalNearS, pollIntervalS, RequestLedger, simulatePolls, type CadenceConfig, type PollSchedule } from '../src/core/rt/budget.ts';
import { fromWallTime } from '../src/core/time.ts';

const SCHEDULE = (rtConfig as unknown as CadenceConfig).poll;
/** Local (Vancouver) time. 2026-09-28 is a Monday. */
const at = (day: number, hour: number, minute = 0) => fromWallTime({ year: 2026, month: 9, day, hour, minute, second: 0 });

describe('poll schedule', () => {
  it('picks the band by local time and day of week', () => {
    expect(pollIntervalS(SCHEDULE, 'positions', at(28, 8))).toBe(60); // Monday AM peak
    expect(pollIntervalS(SCHEDULE, 'positions', at(28, 12))).toBe(150); // midday
    expect(pollIntervalS(SCHEDULE, 'positions', at(28, 2))).toBe(300); // night
    expect(pollIntervalS(SCHEDULE, 'positions', at(28, 23, 30))).toBe(300);
    expect(pollIntervalS(SCHEDULE, 'positions', at(26, 8))).toBe(150); // Saturday morning
    expect(pollIntervalS(SCHEDULE, 'positions', at(27, 12))).toBe(90); // Sunday midday
    expect(bandAt(SCHEDULE, at(28, 6, 30)).from).toBe('06:30');
    expect(bandAt(SCHEDULE, at(28, 6, 29)).from).toBe('05:00');
  });

  it('stays under the daily cap in every 24 hours of a week, with room for restarts', () => {
    for (const start of [at(28, 0), at(28, 13, 7), at(26, 0)]) {
      expect(maxRequestsPer24h(SCHEDULE, start, 8)).toBeLessThanOrEqual(SCHEDULE.dailyCap - 25);
    }
  });

  it('uses most of the budget at peak', () => {
    const polls = simulatePolls(SCHEDULE, at(28, 0), at(29, 0));
    const total = polls.positions.length + polls.tripUpdates.length + polls.alerts.length;
    expect(total).toBeGreaterThan(900);
    const peak = polls.positions.filter((t) => (t >= at(28, 6, 30) && t < at(28, 9, 30)) || (t >= at(28, 15) && t < at(28, 18, 30))).length;
    expect(peak / polls.positions.length).toBeGreaterThan(0.5);
  });

  it('near a band change, thresholds use the longer interval on either side', () => {
    // The first poll after the AM peak ends comes 150 s after the last 60 s poll.
    expect(pollIntervalNearS(SCHEDULE, 'positions', at(28, 9, 29))).toBe(150);
    expect(pollIntervalNearS(SCHEDULE, 'positions', at(28, 9, 31))).toBe(150);
    expect(pollIntervalNearS(SCHEDULE, 'positions', at(28, 8))).toBe(60);
    // Positions reach 2 × 300 s: 06:15 is past 05:00's 150 s band and not near the night band.
    expect(pollIntervalNearS(SCHEDULE, 'positions', at(28, 6, 15))).toBe(150);
  });

  it('derives cadence thresholds from the interval in use', () => {
    const c = cadence(rtConfig as unknown as CadenceConfig);
    const cfg = rtConfig as unknown as CadenceConfig;
    expect(c.maxInterpolateS(at(28, 8))).toBe(60 + cfg.interpolateSlackS);
    expect(c.maxExtrapolateS(at(28, 12))).toBe(150 + cfg.extrapolateSlackS);
    expect(c.staleAfterMs(at(28, 2))).toBe((300 + cfg.staleGraceS) * 1000);
    expect(c.coverageGapMs(at(28, 8))).toBe((60 + cfg.coverageSlackS) * 1000);
    expect(c.maxInterpolateLimitS).toBe(300 + cfg.interpolateSlackS);
    // Alerts reach two hours either side (2 × their longest, hourly, interval), so the peak band never shows alone.
    expect(c.alertGraceMs(at(28, 8))).toBe(1800_000);
  });

  it('is keyed by schedule, not only by time', () => {
    const fast: PollSchedule = { dailyCap: 5000, weekday: [{ from: '00:00', positionsS: 20, tripUpdatesS: 60, alertsS: 300 }], weekend: [{ from: '00:00', positionsS: 20, tripUpdatesS: 60, alertsS: 300 }] };
    expect(pollIntervalNearS(SCHEDULE, 'positions', at(28, 8))).toBe(60);
    expect(pollIntervalNearS(fast, 'positions', at(28, 8))).toBe(20);
  });
});

describe('RequestLedger', () => {
  it('allows requests up to the cap in any 24 hours', () => {
    const l = new RequestLedger(3);
    l.record('positions', 0);
    l.record('alerts', 1000);
    expect(l.nextAllowedAt(2000)).toBe(2000);
    l.record('positions', 2000);
    // Full: the next request may go once the first leaves the window.
    expect(l.nextAllowedAt(3000)).toBe(86_400_000);
    expect(l.count(86_400_000)).toBe(2);
    expect(l.nextAllowedAt(86_400_000)).toBe(86_400_000);
  });

  it('remembers the last request per feed and round-trips through JSON', () => {
    const l = new RequestLedger(10);
    l.record('positions', 100);
    l.record('tripUpdates', 200);
    l.record('positions', 300);
    const back = new RequestLedger(10, JSON.parse(JSON.stringify(l)).requests);
    expect(back.lastAt('positions')).toBe(300);
    expect(back.lastAt('tripUpdates')).toBe(200);
    expect(back.lastAt('alerts')).toBeUndefined();
    expect(back.count(300)).toBe(3);
  });

  it('ignores malformed entries', () => {
    const l = new RequestLedger(10, [[5, 'positions'], ['x', 'positions'], [6, 'nonsense']] as never);
    expect(l.count(10)).toBe(1);
  });
});
