// Feature reconciliation on the server (apps/server/README.md#feature-reconciliation): every GTFS
// feed version in gtfs_feeds that hasn't been reconciled, oldest first (gtfs_feeds.seq), one
// transaction per version. Catching up from an empty registry is the same loop. A version's zip
// comes from var/raw/gtfs/<feed>/<version>/, or the archive when it isn't there.

import { existsSync } from "node:fs";
import { sql } from "kysely";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { feedPaths, VAR_DIR } from "@transitopia/data/paths.ts";
import { readFeedRecords } from "@transitopia/data/gtfs-features.ts";
import type { Db } from "@transitopia/db/connect.ts";
import type { FeedInfo } from "@transitopia/transit-core/config.ts";
import {
  reconcile,
  type FeedRecords,
  type ReconcileSettings,
} from "@transitopia/transit-core/features/reconcile.ts";
import { run } from "../jobs/exec.ts";
import {
  applyDecisions,
  idMinter,
  loadSnapshot,
  lockRegistry,
  type ApplyResult,
} from "./registry.ts";

export interface ReconciledVersion extends ApplyResult {
  feed: string;
  version: string;
  seq: number;
}

export async function reconcileFeeds(opts: {
  db: Db;
  feeds: Pick<FeedInfo, "id" | "operator">[];
  settings: ReconcileSettings;
  /** Where archived zips are (ARCHIVE_REMOTE), for versions no longer on disk. */
  archiveRemote?: string | undefined;
  /**
   * Go on past a version whose zip can't be found (local registries only: its refs' ranges then
   * break there). Otherwise the feed's later versions wait for it.
   */
  skipMissing?: boolean | undefined;
  log?: (msg: string) => void;
}): Promise<ReconciledVersion[]> {
  const { db, settings } = opts;
  const log = opts.log ?? (() => {});
  const out: ReconciledVersion[] = [];
  for (const feed of opts.feeds) {
    const done = await db
      .selectFrom("gtfs_feeds")
      .select((eb) => eb.fn.max("seq").as("seq"))
      .where("feed_id", "=", feed.id)
      .where("reconciled_at", "is not", null)
      .executeTakeFirst();
    let prevSeq = done?.seq ?? undefined;
    const pending = await db
      .selectFrom("gtfs_feeds")
      .select(["version", "seq", "object_key"])
      .where("feed_id", "=", feed.id)
      .where("reconciled_at", "is", null)
      .where("seq", ">", prevSeq ?? 0)
      .orderBy("seq")
      .execute();
    for (const v of pending) {
      const zip = await zipOf(
        feed.id,
        v.version,
        v.object_key,
        opts.archiveRemote,
      );
      if (!zip) {
        if (opts.skipMissing) {
          log(
            `features: ${feed.id} ${v.version}: no zip on disk or in the archive, skipped`,
          );
          continue;
        }
        log(
          `features: ${feed.id} ${v.version}: no zip on disk or in the archive; its later versions wait for it`,
        );
        break;
      }
      try {
        const t0 = Date.now();
        const records = await readFeedRecords(zip.path);
        const result = await reconcileVersion(db, {
          feed,
          version: v.version,
          seq: v.seq,
          prevSeq,
          records,
          settings,
        });
        prevSeq = v.seq;
        out.push({ feed: feed.id, version: v.version, seq: v.seq, ...result });
        log(
          `features: ${feed.id} ${v.version}: ${result.minted} minted, ${result.updated} updated, ${result.refsExtended} refs carried on, ${result.refsAdded} added, ${result.flagged} flagged (${Date.now() - t0} ms)`,
        );
      } finally {
        await zip.cleanup();
      }
    }
  }
  // The first reconciliation adds tens of thousands of refs at once: refresh the planner's
  // statistics, or the statistics views join as if the tables were empty.
  if (out.some((r) => r.minted || r.refsAdded))
    await sql`analyze features, feature_refs`.execute(db);
  return out;
}

/** Reconcile one feed version and mark it reconciled, in one transaction. */
export async function reconcileVersion(
  db: Db,
  v: {
    feed: Pick<FeedInfo, "id" | "operator">;
    version: string;
    seq: number;
    prevSeq: number | undefined;
    records: FeedRecords;
    settings: ReconcileSettings;
  },
): Promise<ApplyResult> {
  return db.transaction().execute(async (tx) => {
    await lockRegistry(tx);
    const decisions = reconcile({
      feed: v.feed.id,
      operator: v.feed.operator,
      seq: v.seq,
      prevSeq: v.prevSeq,
      records: v.records,
      snapshot: await loadSnapshot(tx, v.feed.id),
      settings: v.settings,
      mint: await idMinter(tx),
    });
    const r = await applyDecisions(tx, v.feed.id, decisions);
    await tx
      .updateTable("gtfs_feeds")
      .set({ reconciled_at: new Date() })
      .where("feed_id", "=", v.feed.id)
      .where("version", "=", v.version)
      .execute();
    return r;
  });
}

/** A version's zip: on disk, or fetched from the archive into a temporary directory. */
async function zipOf(
  feed: string,
  version: string,
  objectKey: string | null,
  archiveRemote: string | undefined,
): Promise<{ path: string; cleanup: () => Promise<void> } | undefined> {
  const local = join(feedPaths(feed).raw, version, "google_transit.zip");
  if (existsSync(local)) return { path: local, cleanup: async () => {} };
  if (!objectKey || !archiveRemote) return undefined;
  const dir = await mkdtemp(join(VAR_DIR, "tmp-gtfs-"));
  const path = join(dir, "google_transit.zip");
  try {
    await run("rclone", ["copyto", `${archiveRemote}/${objectKey}`, path]);
  } catch {
    await rm(dir, { recursive: true, force: true });
    return undefined;
  }
  return { path, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
