// Fetch and decode TransLink GTFS-realtime feeds, reduced to the fields we use.

import GtfsRealtimeBindings from 'gtfs-realtime-bindings';

const BASE = 'https://gtfsapi.translink.ca/v3';

export interface DecodedPosition {
  vehicleId: string;
  label?: string;
  tripId?: string;
  routeId?: string;
  lat: number;
  lon: number;
  bearing?: number;
  ts?: number; // epoch ms
  stopSeq?: number;
  stopId?: string;
  status?: number;
}

export interface DecodedPositions {
  headerTs: number;
  positions: DecodedPosition[];
}

/** tripId → per-stop-sequence delays (seconds), plus a trip-level fallback. */
export type TripDelays = Map<string, { bySeq: [number, number][]; trip?: number }>;

type FeedObject = {
  header?: { timestamp?: number };
  entity?: {
    vehicle?: {
      trip?: { tripId?: string; routeId?: string };
      vehicle?: { id?: string; label?: string };
      position?: { latitude?: number; longitude?: number; bearing?: number };
      timestamp?: number;
      currentStopSequence?: number;
      stopId?: string;
      currentStatus?: number;
    };
    tripUpdate?: {
      trip?: { tripId?: string };
      delay?: number;
      stopTimeUpdate?: { stopSequence?: number; arrival?: { delay?: number }; departure?: { delay?: number } }[];
    };
  }[];
};

async function fetchFeed(endpoint: string, apiKey: string, signal?: AbortSignal): Promise<FeedObject> {
  const res = await fetch(`${BASE}/${endpoint}?apikey=${encodeURIComponent(apiKey)}`, {
    headers: { 'User-Agent': 'skytrain-viz/0.1' },
    signal,
  });
  // Never include the URL in errors: it contains the key.
  if (!res.ok) throw new Error(`TransLink ${endpoint}: HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const { FeedMessage } = GtfsRealtimeBindings.transit_realtime;
  const msg = FeedMessage.decode(buf);
  return FeedMessage.toObject(msg, { longs: Number, enums: Number }) as FeedObject;
}

export async function fetchPositions(apiKey: string, signal?: AbortSignal): Promise<DecodedPositions> {
  const feed = await fetchFeed('gtfsposition', apiKey, signal);
  const headerTs = (feed.header?.timestamp ?? Date.now() / 1000) * 1000;
  const positions: DecodedPosition[] = [];
  for (const e of feed.entity ?? []) {
    const v = e.vehicle;
    const lat = v?.position?.latitude;
    const lon = v?.position?.longitude;
    const vehicleId = v?.vehicle?.id;
    if (!v || lat === undefined || lon === undefined || !vehicleId) continue;
    const p: DecodedPosition = { vehicleId, lat, lon };
    if (v.vehicle?.label) p.label = v.vehicle.label;
    if (v.trip?.tripId) p.tripId = v.trip.tripId;
    if (v.trip?.routeId) p.routeId = v.trip.routeId;
    if (v.position?.bearing !== undefined) p.bearing = v.position.bearing;
    if (v.timestamp) p.ts = v.timestamp * 1000;
    if (v.currentStopSequence !== undefined) p.stopSeq = v.currentStopSequence;
    if (v.stopId) p.stopId = v.stopId;
    if (v.currentStatus !== undefined) p.status = v.currentStatus;
    positions.push(p);
  }
  return { headerTs, positions };
}

export async function fetchTripDelays(apiKey: string, signal?: AbortSignal): Promise<TripDelays> {
  const feed = await fetchFeed('gtfsrealtime', apiKey, signal);
  const out: TripDelays = new Map();
  for (const e of feed.entity ?? []) {
    const tu = e.tripUpdate;
    const tripId = tu?.trip?.tripId;
    if (!tu || !tripId) continue;
    const bySeq: [number, number][] = [];
    for (const u of tu.stopTimeUpdate ?? []) {
      const d = u.arrival?.delay ?? u.departure?.delay;
      if (u.stopSequence !== undefined && d !== undefined) bySeq.push([u.stopSequence, d]);
    }
    bySeq.sort((a, b) => a[0] - b[0]);
    out.set(tripId, { bySeq, trip: tu.delay });
  }
  return out;
}

/** Delay at the vehicle's current/next stop. */
export function delayFor(delays: TripDelays, tripId: string | undefined, stopSeq: number | undefined): number | undefined {
  if (!tripId) return undefined;
  const d = delays.get(tripId);
  if (!d) return undefined;
  if (stopSeq !== undefined) {
    const next = d.bySeq.find(([seq]) => seq >= stopSeq);
    if (next) return next[1];
  }
  return d.bySeq[0]?.[1] ?? d.trip;
}
