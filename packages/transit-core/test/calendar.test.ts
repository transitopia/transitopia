import { describe, expect, it } from 'vitest';
import { activeServices, indexCalendar, type ServiceCalendar } from '../src/gtfs/calendar.ts';
import { feedForDate, manifestRange, type FeedManifest } from '../src/plan/types.ts';

// Mirrors the structure of TransLink feed 26SEP_20260925: weekday/Sat/Sun calendars, a Mon–Thu
// supplement added only via calendar_dates, and holidays that remove weekday service.
const all = [true, true, true, true, true, true, true];
const cal: ServiceCalendar = {
  calendar: [
    { serviceId: '1', days: [true, true, true, true, true, false, false], start: '20260907', end: '20270103' },
    { serviceId: '2', days: [false, false, false, false, false, true, false], start: '20260907', end: '20270103' },
    { serviceId: '3', days: [false, false, false, false, false, false, true], start: '20260907', end: '20270103' },
    { serviceId: '1101', days: all.map(() => false), start: '20260907', end: '20270103' },
  ],
  exceptions: [
    { serviceId: '1', date: '20260930', type: 2 }, // Truth and Reconciliation Day (Wednesday)
    { serviceId: '3', date: '20260930', type: 1 },
    { serviceId: '1101', date: '20260928', type: 1 },
    { serviceId: '1101', date: '20260929', type: 1 },
    { serviceId: '1101', date: '20261001', type: 1 },
  ],
};

describe('activeServices', () => {
  it('Monday–Thursday get weekday plus the supplement', () => {
    expect([...activeServices(cal, '20260928')].sort()).toEqual(['1', '1101']);
  });
  it('Friday is weekday only', () => {
    expect([...activeServices(cal, '20261002')]).toEqual(['1']);
  });
  it('weekends use their own services', () => {
    expect([...activeServices(cal, '20261003')]).toEqual(['2']);
    expect([...activeServices(cal, '20261004')]).toEqual(['3']);
  });
  it('holidays remove weekday service and add Sunday service', () => {
    expect([...activeServices(cal, '20260930')]).toEqual(['3']);
  });
  it('dates outside the calendar range have no service', () => {
    expect(activeServices(cal, '20270104').size).toBe(0);
  });
  it('indexed lookup agrees with the direct one', () => {
    const lookup = indexCalendar(cal);
    for (const d of ['20260928', '20260930', '20261002', '20261003']) {
      expect(lookup(d)).toEqual(activeServices(cal, d));
    }
  });
});

describe('feedForDate', () => {
  const manifest: FeedManifest = {
    schema: 1,
    generatedAt: '',
    feeds: [
      { version: '26SEP', start: '20260907', end: '20270103', path: 'a', builtAt: '' },
      { version: '26DEC', start: '20261214', end: '20270405', path: 'b', builtAt: '' },
    ],
  };
  it('picks the newest feed covering the date', () => {
    expect(feedForDate(manifest, '20261001')?.version).toBe('26SEP');
    expect(feedForDate(manifest, '20261220')?.version).toBe('26DEC');
    expect(feedForDate(manifest, '20270301')?.version).toBe('26DEC');
    expect(feedForDate(manifest, '20270501')).toBeUndefined();
  });
  it('reports the union of feed ranges', () => {
    expect(manifestRange(manifest)).toEqual({ start: '20260907', end: '20270405' });
  });
});
