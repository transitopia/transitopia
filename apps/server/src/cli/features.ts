// The feature registry from the command line (apps/server/README.md#feature-reconciliation), until
// /admin has these tools. Keys are IDs (a name suffix is fine) or refs (stop:translink:50123).
//
//   DATABASE_URL=postgres://… npm run features -- reconcile [--feed <id>] [--skip-missing]
//   DATABASE_URL=postgres://… npm run features -- show <key>
//   DATABASE_URL=postgres://… npm run features -- move <stop> <station or exchange>
//   DATABASE_URL=postgres://… npm run features -- detach <stop> [<stop> …]
//   DATABASE_URL=postgres://… npm run features -- retire <key> [<key> …]
//
// reconcile records the feed versions on disk in gtfs_feeds, then reconciles every one not yet
// reconciled, as the server's data build does (ARCHIVE_REMOTE: fetch older zips from the archive).
// IDs minted locally are throwaway: only production's are published.

import { readFeed, readFeeds } from "@transitopia/data/paths.ts";
import { createDb, type Db } from "@transitopia/db/connect.ts";
import { migrate } from "@transitopia/db/migrate.ts";
import { reconcileConfig } from "../config.ts";
import { recordFeeds } from "../jobs/data-build.ts";
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

const USAGE = `Usage: DATABASE_URL=postgres://… npm run features -- <command>
  reconcile [--feed <id>] [--skip-missing]
  show <key>
  move <stop> <station or exchange>
  detach <stop> [<stop> …]
  retire <key> [<key> …]`;

const url = process.env.DATABASE_URL;
const [command, ...args] = process.argv.slice(2);
if (!url || !command) {
  console.error(USAGE);
  process.exit(1);
}

const { db, pool } = createDb(url);
try {
  await migrate(pool);
  await main(db);
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await db.destroy();
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
