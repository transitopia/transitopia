import { describe, expect, it } from 'vitest';
import {
  addDays,
  dayOfWeek,
  formatServiceTime,
  localDate,
  parseGtfsTime,
  serviceDayStart,
  toWallTime,
} from '../src/core/time.ts';

describe('parseGtfsTime', () => {
  it('handles leading spaces and times past midnight', () => {
    expect(parseGtfsTime(' 5:05:00')).toBe(5 * 3600 + 5 * 60);
    expect(parseGtfsTime('25:30:00')).toBe(25 * 3600 + 30 * 60);
    expect(parseGtfsTime('00:00:01')).toBe(1);
  });
  it('returns NaN for blanks and throws on garbage', () => {
    expect(parseGtfsTime('  ')).toBeNaN();
    expect(() => parseGtfsTime('5:05')).toThrow();
    expect(() => parseGtfsTime('a:b:c')).toThrow();
  });
  it('formats service times beyond 24h', () => {
    expect(formatServiceTime(25 * 3600 + 30 * 60)).toBe('25:30');
    expect(formatServiceTime(3661, true)).toBe('1:01:01');
  });
});

describe('service dates', () => {
  it('does date arithmetic across month and year boundaries', () => {
    expect(addDays('20260930', 1)).toBe('20261001');
    expect(addDays('20270101', -1)).toBe('20261231');
  });
  it('computes day of week with Monday = 0', () => {
    expect(dayOfWeek('20260925')).toBe(4); // Friday
    expect(dayOfWeek('20260927')).toBe(6); // Sunday
    expect(dayOfWeek('20260928')).toBe(0); // Monday
  });
});

describe('serviceDayStart (noon minus 12h)', () => {
  it('equals local midnight on ordinary days', () => {
    const t = serviceDayStart('20260925');
    expect(new Date(t).toISOString()).toBe('2026-09-25T07:00:00.000Z'); // PDT = UTC-7
    expect(toWallTime(t)).toMatchObject({ hour: 0, minute: 0 });
  });
  it('is 01:00 PDT on the fall-back day, so 05:00 service time is 05:00 PST', () => {
    // DST ends 2026-11-01 at 02:00 PDT.
    const t = serviceDayStart('20261101');
    expect(new Date(t).toISOString()).toBe('2026-11-01T08:00:00.000Z');
    expect(toWallTime(t + 5 * 3600_000)).toMatchObject({ hour: 5, minute: 0 });
  });
  it('is 23:00 PST the previous evening on the spring-forward day', () => {
    // DST starts 2027-03-14 at 02:00 PST.
    const t = serviceDayStart('20270314');
    expect(new Date(t).toISOString()).toBe('2027-03-14T07:00:00.000Z');
    expect(toWallTime(t + 12 * 3600_000)).toMatchObject({ hour: 12 });
  });
  it('maps instants back to local dates', () => {
    expect(localDate(Date.parse('2026-09-26T06:59:00Z'))).toBe('20260925');
    expect(localDate(Date.parse('2026-09-26T07:01:00Z'))).toBe('20260926');
  });
});
