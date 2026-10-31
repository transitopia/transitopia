// The feature registry from the command line (apps/server/README.md#feature-reconciliation), until
// /admin has these tools. Keys are IDs (a name suffix is fine) or refs (stop:translink:50123).
//
//   npm run features -- pull       production's latest public export → the local registry (WIPES
//                                  the database's feature tables), then the places files
//   npm run features -- places     the places files from the registry (pulled first if it's empty)
//   npm run features -- reconcile [--feed <id>] [--skip-missing]
//   npm run features -- show <key>
//   npm run features -- move <stop> <station or exchange>
//   npm run features -- detach <stop> [<stop> …]
//   npm run features -- retire <key> [<key> …]
//
// The registry is DATABASE_URL's database, else the local one (npm run db:up).
// reconcile records the feed versions on disk in gtfs_feeds, then reconciles every one not yet
// reconciled, as the server's data build does (ARCHIVE_REMOTE: fetch older zips from the archive),
// and loads the latest cycling build's bike routes (npm run data:cycling), giving them IDs.
// IDs minted locally are throwaway: only production's are published.

import { readFeed, readFeeds } from "@transitopia/data/paths.ts";
import {
  decodeRegistry,
  EXPORT_POINTER,
  writeFeedPlaces,
  type Registry,
} from "@transitopia/data/features.ts";
import type { ExportPointer } from "@transitopia/shared/features.ts";
import { loadRegistry, registryFromDb } from "../features/export.ts";
import { createDb, databaseUrl, type Db } from "@transitopia/db/connect.ts";
import { migrate } from "@transitopia/db/migrate.ts";
import { reconcileConfig } from "../config.ts";
import { loadRoutes, recordFeeds } from "../jobs/data-build.ts";
import { reconcileFeeds } from "../features/reconcile.ts";
import {
  childrenOf,
  findFeature,
  refsOf,
  retire,
  setParent,
  type FeatureRow,
} from "../features/registry.ts";
import { syncSources } from "../sources.ts";

const USAGE = `Usage: [DATABASE_URL=postgres://…] npm run features -- <command>
  pull                                     (wipes the local registry)
  places
  reconcile [--feed <id>] [--skip-missing]
  show <key>
  move <stop> <station or exchange>
  detach <stop> [<stop> …]
  retire <key> [<key> …]`;

/** Where `pull` downloads production's export from (the published data root). */
const PULL_FROM =
  process.env.FEATURES_PULL_FROM ?? "https://data.transitopia.org/";

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error(USAGE);
  process.exit(1);
}

/** Production's latest public export into the database, replacing its registry. */
async function pull(db: Db): Promise<Registry> {
  const get = async (path: string) => {
    const r = await fetch(new URL(path, PULL_FROM));
    if (!r.ok)
      throw new Error(`${r.status} for ${new URL(path, PULL_FROM).href}`);
    return r;
  };
  const pointer = (await (await get(EXPORT_POINTER)).json()) as ExportPointer;
  const gz = Buffer.from(await (await get(pointer.path)).arrayBuffer());
  const registry = decodeRegistry(gz);
  console.log(
    `pulled ${pointer.path} (${registry.features.length} features, ${registry.refs.length} refs, ${pointer.generatedAt})`,
  );
  await syncSources(db);
  const r = await loadRegistry(db, registry);
  console.log(
    `the local database's registry was replaced: ${Object.entries(r.cleared)
      .map(([t, n]) => `${n} ${t}`)
      .join(", ")} deleted`,
  );
  return registry;
}

/** The places files, from the registry (production's, pulled, when the database has none yet). */
async function places(db: Db, registry?: Registry): Promise<void> {
  registry ??= await registryFromDb(db);
  if (!registry.features.length) {
    console.log("the registry is empty: pulling production's");
    registry = await pull(db);
  }
  const feeds = (await readFeeds()).map((f) => f.id);
  const written = await writeFeedPlaces(registry, feeds, console.log);
  console.log(`${written.length} places files written`);
}

async function resolve(db: Db, key: string): Promise<FeatureRow> {
  const f = await findFeature(db, key);
  if (!f) throw new Error(`no feature for ${key}`);
  return f;
}

const describe = (f: FeatureRow) =>
  `${f.id} ${f.kind} "${f.name}"${f.status === "active" ? "" : ` (${f.status})`}`;

async function main(db: Db): Promise<void> {
  switch (command) {
    case "pull":
      return places(db, await pull(db));
    case "places":
      return places(db);
    case "reconcile": {
      const only =
        args.includes("--feed") ? args[args.indexOf("--feed") + 1] : undefined;
      const feeds = only ? [await readFeed(only)] : await readFeeds();
      await syncSources(db);
      const archiveRemote = process.env.ARCHIVE_REMOTE || undefined;
      for (const f of feeds)
        await recordFeeds(db, f.id, undefined, console.log);
      const r = await reconcileFeeds({
        db,
        feeds,
        settings: reconcileConfig,
        archiveRemote,
        skipMissing: args.includes("--skip-missing"),
        log: console.log,
      });
      console.log(`${r.length} feed versions reconciled`);
      await loadRoutes(db, console.log);
      return;
    }
    case "show": {
      if (args.length !== 1) throw new Error(USAGE);
      const f = await resolve(db, args[0]!);
      if (f.redirectedFrom) console.log(`${f.redirectedFrom} was merged into:`);
      console.log(describe(f));
      if (f.lon !== null)
        console.log(`  at ${f.lat!.toFixed(6)}, ${f.lon.toFixed(6)}`);
      if (f.parentId)
        console.log(`  in ${describe(await resolve(db, f.parentId))}`);
      for (const r of await refsOf(db, f.id))
        console.log(
          `  ${r.ref}${r.versions.length ? `  ${r.versions.join(" … ")}` : ""}`,
        );
      for (const c of await childrenOf(db, f.id))
        console.log(`  contains ${describe(c)}`);
      return;
    }
    case "move": {
      if (args.length !== 2) throw new Error(USAGE);
      const stop = await resolve(db, args[0]!);
      const place = await resolve(db, args[1]!);
      const r = await setParent(db, stop.id, place.id);
      console.log(`${describe(stop)}: ${r.before ?? "none"} → ${r.after}`);
      return;
    }
    case "detach": {
      if (!args.length) throw new Error(USAGE);
      for (const key of args) {
        const stop = await resolve(db, key);
        const r = await setParent(db, stop.id, null);
        console.log(`${describe(stop)}: ${r.before ?? "none"} → none`);
      }
      return;
    }
    case "retire": {
      if (!args.length) throw new Error(USAGE);
      for (const key of args) {
        const f = await resolve(db, key);
        await retire(db, f.id);
        console.log(`${describe(f)} retired`);
      }
      return;
    }
    default:
      throw new Error(USAGE);
  }
}

// Last, so every declaration above is initialised before it runs.
const conn = createDb(databaseUrl());
try {
  await migrate(conn.pool);
  await main(conn.db);
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await conn.db.destroy();
}
