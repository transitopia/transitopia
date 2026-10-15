// Fetch and decode a feed's GTFS-realtime (config/feeds/<feed>/feed.json → realtime.urls), reduced to the
// fields we use. The URLs may carry an API key: they never appear in errors or logs.

import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import {
  realtimeUrl,
  type FeedRealtime,
} from "@transitopia/transit-core/config.ts";

/** Where and how to fetch a feed's real-time data. */
export interface Upstream {
  /** For errors: the feed's name ("TransLink"). */
  name: string;
  rt: FeedRealtime;
  apiKey: string | undefined;
}

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
  /** Response size (bytes). */
  bytes: number;
}

/** tripId → per-stop-sequence delays (seconds), plus a trip-level fallback. */
export type TripDelays = Map<
  string,
  { bySeq: [number, number][]; trip?: number | undefined }
>;

/** A trip in the trip-updates feed, as sent. */
export interface TripRef {
  tripId: string;
  routeId?: string;
  /** Service date, YYYYMMDD. */
  startDate?: string;
  /** Stop time updates with a stop sequence and a delay (what delays are read from). */
  stopDelays: number;
}

/** A trip TransLink reports as cancelled, or running with stops skipped. */
export interface TripChange {
  tripId: string;
  routeId?: string;
  /** Service date, YYYYMMDD. */
  startDate?: string;
  cancelled: boolean;
  skippedStopIds: string[];
}

// GTFS-RT enums (decoded as numbers).
const TRIP_CANCELED = 3;
const STOP_SKIPPED = 1;

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
      trip?: {
        tripId?: string;
        routeId?: string;
        startDate?: string;
        scheduleRelationship?: number;
      };
      delay?: number;
      stopTimeUpdate?: {
        stopSequence?: number;
        stopId?: string;
        scheduleRelationship?: number;
        arrival?: { delay?: number };
        departure?: { delay?: number };
      }[];
    };
    id?: string;
    alert?: {
      activePeriod?: { start?: number; end?: number }[];
      informedEntity?: {
        routeId?: string;
        stopId?: string;
        directionId?: number;
        trip?: { tripId?: string };
      }[];
      cause?: number;
      effect?: number;
      headerText?: { translation?: { text?: string; language?: string }[] };
      descriptionText?: {
        translation?: { text?: string; language?: string }[];
      };
    };
  }[];
};

export interface DecodedAlert {
  id: string;
  routeIds: string[];
  stopIds: string[];
  /** Informed routes, with the direction or trip when the alert narrows to one. */
  entities: { routeId: string; directionId?: number; tripId?: string }[];
  /** Epoch ms. */
  periods: { start?: number; end?: number }[];
  cause?: number;
  effect?: number;
  header: string;
  description: string;
}

const english = (t?: {
  translation?: { text?: string; language?: string }[];
}) =>
  (
    t?.translation?.find((x) => !x.language || x.language.startsWith("en"))
    ?? t?.translation?.[0]
  )?.text ?? "";

/** Service alerts (all routes; callers filter to theirs). */
export async function fetchAlerts(
  up: Upstream,
  signal?: AbortSignal,
): Promise<DecodedAlert[]> {
  const { feed } = await fetchFeed(up, "alerts", signal);
  const out: DecodedAlert[] = [];
  for (const e of feed.entity ?? []) {
    const a = e.alert;
    if (!a || !e.id) continue;
    out.push({
      id: e.id,
      routeIds: [
        ...new Set(
          (a.informedEntity ?? [])
            .map((x) => x.routeId)
            .filter((x): x is string => Boolean(x)),
        ),
      ],
      stopIds: [
        ...new Set(
          (a.informedEntity ?? [])
            .map((x) => x.stopId)
            .filter((x): x is string => Boolean(x)),
        ),
      ],
      entities: [
        ...new Map(
          (a.informedEntity ?? [])
            .filter((x) => x.routeId)
            .map((x) => {
              const ent: DecodedAlert["entities"][number] = {
                routeId: x.routeId!,
              };
              if (x.directionId !== undefined && x.directionId !== null)
                ent.directionId = x.directionId;
              if (x.trip?.tripId) ent.tripId = x.trip.tripId;
              return [JSON.stringify(ent), ent] as const;
            }),
        ).values(),
      ],
      periods: (a.activePeriod ?? []).map((p) => ({
        ...(p.start ? { start: p.start * 1000 } : {}),
        ...(p.end ? { end: p.end * 1000 } : {}),
      })),
      ...(a.cause !== undefined ? { cause: a.cause } : {}),
      ...(a.effect !== undefined ? { effect: a.effect } : {}),
      header: english(a.headerText),
      description: english(a.descriptionText),
    });
  }
  return out;
}

async function fetchFeed(
  up: Upstream,
  endpoint: keyof FeedRealtime["urls"],
  signal?: AbortSignal,
): Promise<{ feed: FeedObject; bytes: number }> {
  const res = await fetch(realtimeUrl(up.rt, endpoint, up.apiKey), {
    headers: { "User-Agent": "Transitopia (+https://www.transitopia.org)" },
    signal: signal ?? null,
  });
  // Never include the URL in errors: it may contain the key.
  if (!res.ok) throw new Error(`${up.name} ${endpoint}: HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const { FeedMessage } = GtfsRealtimeBindings.transit_realtime;
  const msg = FeedMessage.decode(buf);
  const feed = FeedMessage.toObject(msg, {
    longs: Number,
    enums: Number,
  }) as FeedObject;
  return { feed, bytes: buf.byteLength };
}

export async function fetchPositions(
  up: Upstream,
  signal?: AbortSignal,
): Promise<DecodedPositions> {
  const { feed, bytes } = await fetchFeed(up, "positions", signal);
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
  return { headerTs, positions, bytes };
}

/** Trip updates: delays per trip, and trips cancelled or skipping stops. */
export async function fetchTripUpdates(
  up: Upstream,
  signal?: AbortSignal,
): Promise<{
  delays: TripDelays;
  changes: TripChange[];
  trips: TripRef[];
  headerTs: number | undefined;
  bytes: number;
}> {
  const { feed, bytes } = await fetchFeed(up, "tripUpdates", signal);
  const delays: TripDelays = new Map();
  const changes: TripChange[] = [];
  const trips: TripRef[] = [];
  for (const e of feed.entity ?? []) {
    const tu = e.tripUpdate;
    const tripId = tu?.trip?.tripId;
    if (!tu || !tripId) continue;
    const cancelled = tu.trip?.scheduleRelationship === TRIP_CANCELED;
    const bySeq: [number, number][] = [];
    const skippedStopIds: string[] = [];
    for (const u of tu.stopTimeUpdate ?? []) {
      if (u.scheduleRelationship === STOP_SKIPPED) {
        if (u.stopId) skippedStopIds.push(u.stopId);
        continue;
      }
      const d = u.arrival?.delay ?? u.departure?.delay;
      if (u.stopSequence !== undefined && d !== undefined)
        bySeq.push([u.stopSequence, d]);
    }
    const ref: TripRef = { tripId, stopDelays: bySeq.length };
    if (tu.trip?.routeId) ref.routeId = tu.trip.routeId;
    if (tu.trip?.startDate) ref.startDate = tu.trip.startDate;
    trips.push(ref);
    if (cancelled || skippedStopIds.length) {
      const c: TripChange = { tripId, cancelled, skippedStopIds };
      if (tu.trip?.routeId) c.routeId = tu.trip.routeId;
      if (tu.trip?.startDate) c.startDate = tu.trip.startDate;
      changes.push(c);
    }
    if (cancelled) continue;
    bySeq.sort((a, b) => a[0] - b[0]);
    delays.set(tripId, { bySeq, trip: tu.delay });
  }
  const headerTs =
    feed.header?.timestamp ? feed.header.timestamp * 1000 : undefined;
  return { delays, changes, trips, headerTs, bytes };
}

/** What a trip-updates poll held, and how well it matched the buses in the latest positions poll. */
export interface TripFeedSummary {
  /** When it was polled (epoch ms). */
  at: number;
  bytes: number;
  /** Age of the feed's own timestamp when polled (s), if it has one. */
  headerAgeS: number | null;
  trips: number;
  /** Trips with at least one stop delay. */
  withStopDelays: number;
  /** Trips that a bus in the latest positions poll is running. */
  matched: number;
  /** Buses on a trip in the latest positions poll, and how many of their trips are in the feed. */
  busesOnTrips: number;
  busesMatched: number;
  /** A few trips in the feed no bus reports, and buses' trips missing from it, to compare. */
  unmatchedTrips: TripRef[];
  unmatchedBuses: { tripId: string; routeId?: string }[];
}

/** Unmatched examples kept in a summary. */
const SUMMARY_SAMPLES = 5;

export function tripFeedSummary(
  feed: { trips: TripRef[]; headerTs: number | undefined; bytes: number },
  /** Trip id → route id of each bus on a trip in the latest positions poll. */
  buses: ReadonlyMap<string, string | undefined>,
  at: number,
): TripFeedSummary {
  const inFeed = new Set(feed.trips.map((t) => t.tripId));
  const unmatchedTrips = feed.trips.filter((t) => !buses.has(t.tripId));
  const unmatchedBuses = [...buses].filter(([id]) => !inFeed.has(id));
  return {
    at,
    bytes: feed.bytes,
    headerAgeS:
      feed.headerTs === undefined ?
        null
      : Math.round((at - feed.headerTs) / 1000),
    trips: feed.trips.length,
    withStopDelays: feed.trips.filter((t) => t.stopDelays > 0).length,
    matched: feed.trips.length - unmatchedTrips.length,
    busesOnTrips: buses.size,
    busesMatched: buses.size - unmatchedBuses.length,
    unmatchedTrips: unmatchedTrips.slice(0, SUMMARY_SAMPLES),
    unmatchedBuses: unmatchedBuses
      .slice(0, SUMMARY_SAMPLES)
      .map(([tripId, routeId]) => (routeId ? { tripId, routeId } : { tripId })),
  };
}

/** Delay at the vehicle's current/next stop. */
export function delayFor(
  delays: TripDelays,
  tripId: string | undefined,
  stopSeq: number | undefined,
): number | undefined {
  if (!tripId) return undefined;
  const d = delays.get(tripId);
  if (!d) return undefined;
  if (stopSeq !== undefined) {
    const next = d.bySeq.find(([seq]) => seq >= stopSeq);
    if (next) return next[1];
  }
  return d.bySeq[0]?.[1] ?? d.trip;
}
