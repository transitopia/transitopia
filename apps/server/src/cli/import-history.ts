// Import recorded history into the database (apps/server/README.md#command-line-tools)
// Idempotent: hours, batches and versions already imported are skipped.
//
//   DATABASE_URL=postgres://… npm run db:import-history [-- --var <dir>]
//
//   var/rt-history/<date>/<HH>.ndjson[.gz]  → rt_polls + rt_positions
//   var/rt-history/changes/<date>.json      → trip_changes (drawn routes only, as recorded)
//   var/rt-history/requests.json            → upstream_requests (the 24-hour ledger)
//   var/ais-history/<date>/<HH>.ndjson[.gz] → rt_polls + ais_fixes
//   var/dispatch-history/<date>/<v>.json    → dispatch_versions
//   var/raw/gtfs/<version>/                 → gtfs_feeds (without archive keys; the data job uploads them)
//   regions/metro-vancouver/{observations,disruptions} → corrections (as on every start)
//
// The files themselves stay where they are: the server keeps serving /rt/history, /rt/changes and
// dispatch versions from them. Alerts (alerts.ndjson, and the bus alerts inside changes/) aren't
// imported into the alerts table: they're in another shape (our route keys, not GTFS ids).

import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import region from "@transitopia/region-metro-vancouver/region.json" with { type: "json" };
import {
  VAR_DIR,
  PUBLIC_DATA_DIR,
  PUBLIC_DIR,
  readJson,
} from "@transitopia/pipelines/lib/paths.ts";
import { archivedFeeds } from "@transitopia/pipelines/lib/gtfs-day.ts";
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
import type {
  FeedManifest,
  ServicePlan,
} from "@transitopia/transit-core/plan/types.ts";
import { Store } from "../store.ts";
import { CorrectionsRepo } from "../corrections.ts";

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
const store = new Store(db, region.id);

/** Our route key → GTFS route_id, from the built plans (the newest feed wins). */
async function routeIds(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const manifest = await readJson<FeedManifest>(
      join(PUBLIC_DATA_DIR, "manifest.json"),
    );
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
  source: "gtfs-rt" | "ais",
  t: number,
): Promise<boolean> {
  return Boolean(
    await db
      .selectFrom("rt_polls")
      .select("fetched_at")
      .where("region_id", "=", region.id)
      .where("source", "=", source)
      .where("fetched_at", "=", new Date(t))
      .executeTakeFirst(),
  );
}

// Positions.
const ids = await routeIds();
let hours = 0;
let polls = 0;
for await (const h of hourFiles(join(varDir, "rt-history"))) {
  if (
    !h.snapshots.length
    || (await imported("gtfs-rt", h.snapshots[0]!.fetchedAt))
  )
    continue;
  await ensurePartitionsFor(
    db,
    h.snapshots[0]!.fetchedAt,
    h.snapshots[h.snapshots.length - 1]!.fetchedAt,
  );
  for (const s of h.snapshots) {
    if (await imported("gtfs-rt", s.fetchedAt)) continue;
    await store.recordPositions(
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
log(`positions: ${polls} polls from ${hours} hours`);

// AIS.
let batches = 0;
for await (const h of hourFiles(join(varDir, "ais-history"))) {
  if (!h.snapshots.length || (await imported("ais", h.snapshots[0]!.fetchedAt)))
    continue;
  await ensurePartitionsFor(
    db,
    h.snapshots[0]!.fetchedAt,
    h.snapshots[h.snapshots.length - 1]!.fetchedAt,
  );
  for (const s of h.snapshots) {
    if (await imported("ais", s.fetchedAt)) continue;
    await store.recordAis(s.fetchedAt, s.vehicles.map(vehicleToFix));
    batches++;
  }
}
log(`AIS: ${batches} batches`);

// Service changes (first and last sighting as recorded).
const changesDir = join(varDir, "rt-history", "changes");
let tripChanges = 0;
if (existsSync(changesDir))
  for (const f of (await readdir(changesDir)).filter((f) =>
    /^\d{8}\.json$/.test(f),
  )) {
    const d = await readJson<RtDayChanges>(join(changesDir, f));
    const iso = `${d.date.slice(0, 4)}-${d.date.slice(4, 6)}-${d.date.slice(6, 8)}`;
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
      const seen = new Date(r.first ?? Date.parse(`${iso}T12:00:00Z`));
      await db
        .insertInto("trip_changes")
        .values({
          region_id: region.id,
          service_date: iso,
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
log(`trip changes: ${tripChanges}`);

// The request ledger, so the daily cap counts the local recorder's last 24 hours.
try {
  const ledger = await readJson<{ requests?: [number, string][] }>(
    join(varDir, "rt-history", "requests.json"),
  );
  const since = Date.now() - 86_400_000;
  const known = new Set(
    (await store.recentRequests("translink")).map(([t]) => t),
  );
  let n = 0;
  for (const [ts, feed] of ledger.requests ?? [])
    if (ts > since && !known.has(ts)) {
      await store.recordRequest({ provider: "translink", feed, ts });
      n++;
    }
  log(`request ledger: ${n} requests from the last 24 hours`);
} catch {
  log("no request ledger (var/rt-history/requests.json)");
}

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

// GTFS feeds (the data job archives the zips and fills in object keys).
for (const f of await archivedFeeds(join(varDir, "raw", "gtfs"))) {
  const iso = (d: string) =>
    `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  await db
    .insertInto("gtfs_feeds")
    .values({
      region_id: region.id,
      version: f.version,
      start_date: iso(f.start),
      end_date: iso(f.end),
      fetched_at: new Date(),
      sha256: "",
      bytes: 0,
      object_key: null,
    })
    .onConflict((oc) => oc.doNothing())
    .execute();
}

const n = await new CorrectionsRepo(db, region.id).importFiles();
log(
  `corrections: ${n.observationSets} observation sets and ${n.disruptions} disruptions`,
);
await db.destroy();
