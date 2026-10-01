// Fetch and decode TransLink GTFS-realtime feeds, reduced to the fields we use.

import GtfsRealtimeBindings from "gtfs-realtime-bindings";

const BASE = "https://gtfsapi.translink.ca/v3";

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
export type TripDelays = Map<
  string,
  { bySeq: [number, number][]; trip?: number | undefined }
>;

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
  apiKey: string,
  signal?: AbortSignal,
): Promise<DecodedAlert[]> {
  const feed = await fetchFeed("gtfsalerts", apiKey, signal);
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
  endpoint: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<FeedObject> {
  const res = await fetch(
    `${BASE}/${endpoint}?apikey=${encodeURIComponent(apiKey)}`,
    {
      headers: { "User-Agent": "Transitopia (+https://www.transitopia.org)" },
      signal: signal ?? null,
    },
  );
  // Never include the URL in errors: it contains the key.
  if (!res.ok) throw new Error(`TransLink ${endpoint}: HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const { FeedMessage } = GtfsRealtimeBindings.transit_realtime;
  const msg = FeedMessage.decode(buf);
  return FeedMessage.toObject(msg, {
    longs: Number,
    enums: Number,
  }) as FeedObject;
}

export async function fetchPositions(
  apiKey: string,
  signal?: AbortSignal,
): Promise<DecodedPositions> {
  const feed = await fetchFeed("gtfsposition", apiKey, signal);
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

/** Trip updates: delays per trip, and trips cancelled or skipping stops. */
export async function fetchTripUpdates(
  apiKey: string,
  signal?: AbortSignal,
): Promise<{ delays: TripDelays; changes: TripChange[] }> {
  const feed = await fetchFeed("gtfsrealtime", apiKey, signal);
  const delays: TripDelays = new Map();
  const changes: TripChange[] = [];
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
  return { delays, changes };
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
