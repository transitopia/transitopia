import { describe, expect, it } from 'vitest';
import { draftFromAlert, type ServiceAlert } from '../src/core/disruption/alerts.ts';

// Alert texts as TransLink published them (GTFS-RT, 2026-09-28).
const canada: ServiceAlert = {
  id: '756351',
  lines: ['canada'],
  stopIds: ['11293'],
  periods: [{ start: Date.parse('2026-09-28T21:00:00-07:00'), end: Date.parse('2026-09-29T03:00:00-07:00') }],
  header:
    'Canada Line Track Maintenance on Mon, Sept 28 from 9:00 PM until the end of service. Trains will single-track between Bridgeport Station and Richmond-Brighouse Station. Please allow extra travel time.',
  description:
    'The effective headways during this work are: \nWaterfront Station - Bridgeport Station - 10 minutes \nBridgeport Station - Richmond-Brighouse Station - 20 minutes \nBridgeport Station - YVR Airport Station - 20 minutes \n\nLast trains will depart stations approximately 5 minutes later than normal timetable stated times.',
};
const expo: ServiceAlert = {
  id: '757208',
  lines: ['expo'],
  stopIds: ['8050', '8051'],
  periods: [{ start: Date.parse('2026-09-28T21:30:00-07:00'), end: Date.parse('2026-09-29T03:00:00-07:00') }],
  header:
    'Expo Line Track Maintenance on Mon Sep 28 from 9:30 PM until the end of service. Trains will single-track in both directions between Edmonds Station & Royal Oak Station. Platform 1 will be closed; please board all trains from Platform 2 at both stations.',
  description: 'Expo Line trains will operate Waterfront <-> King George/Production Way, stopping at Royal Oak platform 2 and Edmonds platform 2 in both directions.',
};

describe('alert drafts', () => {
  it('drafts single-tracking and headways from the alert text, without guessing the open track', () => {
    const { draft } = draftFromAlert(canada);
    expect(draft?.status).toBe('draft');
    expect(draft?.singleTrack).toEqual([{ line: 'canada', between: ['Bridgeport', 'Richmond-Brighouse'], keep: '' }]);
    expect(draft?.headway).toEqual([
      { line: 'canada', between: ['Waterfront', 'Bridgeport'], minS: 600 },
      { line: 'canada', between: ['Bridgeport', 'Richmond-Brighouse'], minS: 1200 },
      { line: 'canada', between: ['Bridgeport', 'YVR Airport'], minS: 1200 },
    ]);
    expect(draft?.active).toEqual([{ from: '2026-09-29T04:00:00.000Z', until: '2026-09-29T10:00:00.000Z' }]);
  });

  it('pre-fills the open track when the alert names the platform to board from', () => {
    const { draft } = draftFromAlert(expo);
    expect(draft?.singleTrack).toEqual([{ line: 'expo', between: ['Edmonds', 'Royal Oak'], keep: 'Edmonds Station @ Platform 2', pinEnds: true }]);
  });

  it('keeps alerts it cannot model as unparsed', () => {
    const r = draftFromAlert({ ...expo, header: 'Elevator at Braid Station is out of service.', description: '' });
    expect(r.draft).toBeUndefined();
    expect(r.unparsed).toMatch(/no single-tracking/);
    expect(draftFromAlert({ ...canada, lines: ['canada', 'expo'] }).unparsed).toMatch(/more than one line/);
  });
});
