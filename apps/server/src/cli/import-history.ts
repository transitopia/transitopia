// Import recorded history into the database (apps/server/README.md#command-line-tools)
// Idempotent: hours, batches and versions already imported are skipped.
//
//   DATABASE_URL=postgres://… npm run db:import-history [-- --var <dir>]
//
// For each feed with real time (feeds/<feed>/feed.json):
//   var/rt-history/<feed>/<date>/<HH>.ndjson[.gz]  → rt_polls + rt_positions
//   var/rt-history/<feed>/changes/<date>.json      → trip_changes (drawn routes only, as recorded)
//   var/rt-history/<feed>/requests.json            → upstream_requests (the 24-hour ledger)
//   var/raw/gtfs/<feed>/<version>/                 → gtfs_feeds (without archive keys; the data job uploads them)
// and:
//   var/ais-history/<date>/<HH>.ndjson[.gz] → rt_polls + ais_fixes
//   var/dispatch-history/<date>/<v>.json    → dispatch_versions
//   regions/metro-vancouver/{observations,disruptions} → corrections (as on every start)
//
// The files themselves stay where they are: the server keeps serving /rt/history, /rt/changes and
// dispatch versions from them. Alerts (alerts.ndjson, and the bus alerts inside changes/) aren't
// imported into the alerts table: they're in another shape (our route keys, not GTFS ids).

import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  RAIL_REGION,
  VAR_DIR,
  PUBLIC_DIR,
  readFeeds,
  readJson,
  readManifest,
} from "@transitopia/data/paths.ts";
import { migrateLegacyFiles } from "@transitopia/data/legacy.ts";
import { archivedFeeds } from "@transitopia/data/gtfs-day.ts";
import { createDb } from "@transitopia/db/connect.ts";
import { migrate } from "@transitopia/db/migrate.ts";
import { ensurePartitionsFor } from "@transitopia/db/partitions.ts";
import {
  decodeSnapshot,
  isTracked,
  type RtSnapshot,
} from "@transitopia/transit-core/rt/types.ts";
import { vehicleToFix } from "@transitopia/transit-core/ais/fixes.ts";
import type { RtDayChanges } from "@transitopia/transit-core/rt/changes.ts";
import type { DispatchPatch } from "@transitopia/transit-core/dispatch/patch.ts";
import type { ServicePlan } from "@transitopia/transit-core/plan/types.ts";
import { isoDate, Store } from "../store.ts";
import { CorrectionsRepo } from "../corrections.ts";
import { syncSources } from "../sources.ts";

const args = process.argv.slice(2);
const varDir =
  args.includes("--var") ? args[args.indexOf("--var") + 1]! : VAR_DIR;
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Set DATABASE_URL");
  process.exit(1);
}
const log = (m: string) => console.log(`[import] ${m}`);
const { db, pool } = createDb(url);
await migrate(pool, log);
await syncSources(db);
const store = new Store(db, RAIL_REGION);
if (varDir === VAR_DIR) await migrateLegacyFiles();
/** AIS fixes' polls are recorded under TransLink's feed (Store). */
const AIS_FEED = "translink";

/** Our route key → GTFS route_id, from a feed's built plans (the newest version wins). */
async function routeIds(feed: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const manifest = await readManifest(feed);
    for (const f of [...manifest.feeds].reverse()) {
      const plan = await readJson<Pick<ServicePlan, "routes">>(
        join(PUBLIC_DIR, f.path),
      );
      for (const r of plan.routes) out.set(r.key, r.gtfsRouteId);
    }
  } catch {
    log(
      "no built plans (var/public/data): route ids stay empty for drawn routes",
    );
  }
  return out;
}

async function* hourFiles(
  dir: string,
): AsyncGenerator<{ label: string; snapshots: RtSnapshot[] }> {
  if (!existsSync(dir)) return;
  for (const day of (await readdir(dir))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort())
    for (const f of (await readdir(join(dir, day))).sort()) {
      const m = /^(\d{2})\.ndjson(\.gz)?$/.exec(f);
      if (!m) continue;
      const buf = await readFile(join(dir, day, f));
      const snapshots: RtSnapshot[] = [];
      for (const line of (m[2] ? gunzipSync(buf) : buf)
        .toString("utf8")
        .split("\n")) {
        if (!line) continue;
        try {
          snapshots.push(decodeSnapshot(line));
        } catch {
          // A half-written last line.
        }
      }
      yield { label: `${day}T${m[1]}`, snapshots };
    }
}

async function imported(
  feed: string,
  source: "gtfs-rt" | "ais",
  t: number,
): Promise<boolean> {
  return Boolean(
    await db
      .selectFrom("rt_polls")
      .select("fetched_at")
      .where("feed_id", "=", feed)
      .where("source", "=", source)
      .where("fetched_at", "=", new Date(t))
      .executeTakeFirst(),
  );
}

// Positions, service changes and the request ledger, per feed.
for (const feed of (await readFeeds()).filter((f) => f.realtime)) {
  const dir = join(varDir, "rt-history", feed.id);
  const ids = await routeIds(feed.id);
  let hours = 0;
  let polls = 0;
  for await (const h of hourFiles(dir)) {
    if (
      !h.snapshots.length
      || (await imported(feed.id, "gtfs-rt", h.snapshots[0]!.fetchedAt))
    )
      continue;
    await ensurePartitionsFor(
      db,
      h.snapshots[0]!.fetchedAt,
      h.snapshots[h.snapshots.length - 1]!.fetchedAt,
    );
    for (const s of h.snapshots) {
      if (await imported(feed.id, "gtfs-rt", s.fetchedAt)) continue;
      await store.recordPositions(
        feed.id,
        s.fetchedAt,
        s.headerTs,
        s.vehicles.map((v) => {
          const tracked = isTracked(v);
          return {
            ...v,
            routeKey: tracked ? v.routeKey : undefined,
            routeId:
              tracked ?
                ids.get(v.routeKey)
              : v.routeKey.slice("gtfs:".length) || undefined,
          };
        }),
      );
      polls++;
    }
    hours++;
  }
  log(`${feed.id} positions: ${polls} polls from ${hours} hours`);

  // Service changes (first and last sighting as recorded).
  const changesDir = join(dir, "changes");
  let tripChanges = 0;
  if (existsSync(changesDir))
    for (const f of (await readdir(changesDir)).filter((f) =>
      /^\d{8}\.json$/.test(f),
    )) {
      const d = await readJson<RtDayChanges>(join(changesDir, f));
      const date = isoDate(d.date);
      const rows = [
        ...Object.entries(d.cancelled).map(([tripId, [first, last]]) => ({
          tripId,
          cancelled: true,
          skipped: [] as string[],
          first,
          last,
        })),
        ...Object.entries(d.skipped).map(([tripId, skipped]) => ({
          tripId,
          cancelled: false,
          skipped,
          first: undefined,
          last: undefined,
        })),
      ];
      for (const r of rows) {
        const seen = new Date(r.first ?? Date.parse(`${date}T12:00:00Z`));
        await db
          .insertInto("trip_changes")
          .values({
            feed_id: feed.id,
            service_date: date,
            trip_id: r.tripId,
            route_id: null,
            cancelled: r.cancelled,
            skipped_stop_ids: r.skipped,
            first_seen: seen,
            last_seen: new Date(r.last ?? seen.getTime()),
          })
          .onConflict((oc) => oc.doNothing())
          .execute();
        tripChanges++;
      }
    }
  log(`${feed.id} trip changes: ${tripChanges}`);

  // The request ledger, so the daily cap counts the local recorder's last 24 hours.
  try {
    const ledger = await readJson<{ requests?: [number, string][] }>(
      join(dir, "requests.json"),
    );
    const since = Date.now() - 86_400_000;
    const known = new Set(
      (await store.recentRequests(feed.id)).map(([t]) => t),
    );
    let n = 0;
    for (const [ts, endpoint] of ledger.requests ?? [])
      if (ts > since && !known.has(ts)) {
        await store.recordRequest({
          provider: feed.id,
          feed: endpoint,
          ts,
        });
        n++;
      }
    log(`${feed.id} request ledger: ${n} requests from the last 24 hours`);
  } catch {
    log(`${feed.id}: no request ledger (${join(dir, "requests.json")})`);
  }

  // GTFS feeds (the data job archives the zips and fills in object keys).
  for (const f of await archivedFeeds(
    feed.id,
    join(varDir, "raw", "gtfs", feed.id),
  ))
    await db
      .insertInto("gtfs_feeds")
      .values({
        feed_id: feed.id,
        version: f.version,
        start_date: isoDate(f.start),
        end_date: isoDate(f.end),
        fetched_at: new Date(),
        sha256: "",
        bytes: 0,
        object_key: null,
      })
      .onConflict((oc) => oc.doNothing())
      .execute();
}

// AIS.
let batches = 0;
for await (const h of hourFiles(join(varDir, "ais-history"))) {
  if (
    !h.snapshots.length
    || (await imported(AIS_FEED, "ais", h.snapshots[0]!.fetchedAt))
  )
    continue;
  await ensurePartitionsFor(
    db,
    h.snapshots[0]!.fetchedAt,
    h.snapshots[h.snapshots.length - 1]!.fetchedAt,
  );
  for (const s of h.snapshots) {
    if (await imported(AIS_FEED, "ais", s.fetchedAt)) continue;
    await store.recordAis(s.fetchedAt, s.vehicles.map(vehicleToFix));
    batches++;
  }
}
log(`AIS: ${batches} batches`);

// Dispatch versions.
const dispatchDir = join(varDir, "dispatch-history");
let versions = 0;
if (existsSync(dispatchDir))
  for (const date of (await readdir(dispatchDir)).filter((d) =>
    /^\d{8}$/.test(d),
  ))
    for (const f of (await readdir(join(dispatchDir, date))).filter((f) =>
      f.endsWith(".json"),
    )) {
      const patch = await readJson<DispatchPatch>(join(dispatchDir, date, f));
      await store.recordDispatchVersion({
        date,
        version: f.replace(/\.json$/, ""),
        kind: "live",
        inputs: patch.summary.inputs,
      });
      versions++;
    }
log(`dispatch versions: ${versions}`);

const n = await new CorrectionsRepo(db, RAIL_REGION).importFiles();
log(
  `corrections: ${n.observationSets} observation sets and ${n.disruptions} disruptions`,
);
await db.destroy();
