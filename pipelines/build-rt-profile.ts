// Learn bus travel-time profiles from each feed's recorded GTFS-RT positions (packages/transit-core/DESIGN.md#buses):
//   var/rt-history/<feed>/**  →  var/public/data/feeds/<feed>/<version>/rt-profile.<band>.bin (one per time-of-day band, per version with data)
//
//   npm run build:rt-profile [-- --feed <id>] [--max-age-h <hours>]
//
// With --max-age-h, a feed whose current version (feedForDate today) has a profile younger than that
// keeps it: for data builds outside the nightly one, which would learn it again from the same history.
// A profile the site can't read (another format or other bands: a deploy since) is learned again.
// Prediction settings are the feed's (readFeedConfig: config/defaults/rt.json → prediction, its operator's and its own).
// The live view uses the profile to predict buses between fixes; without one it falls back to the
// timetable. Rebuild as history accumulates. Check the effect with `npx tsx pipelines/eval-rt.ts`.

import { readFile, rm, stat } from "node:fs/promises";
import {
  ProfileBuilder,
  type PredictionConfig,
} from "@transitopia/transit-core/rt/profile.ts";
import {
  bandFileName,
  bandProfiles,
  decodeBandProfile,
  encodeBandProfile,
} from "@transitopia/transit-core/rt/profile-bands.ts";
import type { PreparedPlan } from "@transitopia/transit-core/schedule/engine.ts";
import {
  feedVersionFile,
  log,
  readFeed,
  readFeeds,
  readManifest,
  writeAtomic,
  readFeedConfig,
} from "@transitopia/data/paths.ts";
import type { FeedInfo } from "@transitopia/transit-core/config.ts";
import { eachRecordedHour, planLoader } from "./lib/rt-history.ts";
import { addDays, localDate } from "@transitopia/transit-core/time.ts";
import { feedForDate } from "@transitopia/transit-core/plan/types.ts";

/**
 * How old (h) the current version's profile is, or undefined without one the site can read: in
 * another format (a deploy since it was built) or with other bands than `bandStartHours`.
 */
async function currentProfileAgeH(
  feed: string,
  bandStartHours: readonly number[],
): Promise<number | undefined> {
  const current = feedForDate(await readManifest(feed), localDate(Date.now()));
  if (!current) return undefined;
  const file = feedVersionFile(feed, current.version, bandFileName(0));
  const st = await stat(file).catch(() => undefined);
  if (!st) return undefined;
  try {
    const profile = decodeBandProfile(new Uint8Array(await readFile(file)));
    if (profile.bandStartHours.join() !== bandStartHours.join())
      return undefined;
  } catch {
    return undefined; // another format
  }
  return (Date.now() - st.mtimeMs) / 3_600_000;
}

async function buildFeed(feed: FeedInfo, maxAgeH?: number): Promise<void> {
  const rtConfig = (await readFeedConfig(feed.id)).rt;
  if (maxAgeH !== undefined) {
    const age = await currentProfileAgeH(
      feed.id,
      rtConfig.prediction.bandStartHours,
    );
    if (age !== undefined && age < maxAgeH) {
      log(
        `${feed.id}: profile ${age.toFixed(1)} h old (under ${maxAgeH} h); kept`,
      );
      return;
    }
  }
  const cfg: PredictionConfig = rtConfig.prediction;
  const since = addDays(
    localDate(Date.now()),
    -rtConfig.prediction.profileHistoryDays,
  );
  const plans = await planLoader(feed.id);
  const builders = new Map<PreparedPlan, ProfileBuilder>();
  let hours = 0;
  for await (const h of eachRecordedHour(
    feed.id,
    Temporal.PlainDate.from(since).toString(),
  )) {
    hours++;
    // Group each hour's snapshots by the feed in effect.
    const byPlan = new Map<PreparedPlan, typeof h.snapshots>();
    for (const s of h.snapshots) {
      const pp = await plans.forTime(s.fetchedAt);
      if (pp) (byPlan.get(pp) ?? byPlan.set(pp, []).get(pp)!).push(s);
    }
    for (const [pp, snaps] of byPlan) {
      let b = builders.get(pp);
      if (!b)
        builders.set(pp, (b = new ProfileBuilder(pp, cfg, rtConfig.frozenGps)));
      b.add(snaps, h.label);
    }
  }
  if (!hours) {
    log(
      `${feed.id}: no recorded RT history (var/rt-history/${feed.id}/); skipping`,
    );
    return;
  }
  for (const [pp, b] of builders) {
    const profile = b.build();
    const file = (name: string) =>
      feedVersionFile(feed.id, pp.plan.feedVersion, name);
    let bytes = 0;
    for (const band of bandProfiles(profile)) {
      const data = encodeBandProfile(band);
      await writeAtomic(file(bandFileName(band.band)), data);
      bytes += data.length;
    }
    // The single-file profile these replaced.
    await rm(file("rt-profile.json"), { force: true });
    log(
      `${feed.id} ${pp.plan.feedVersion}: profile for ${Object.keys(profile.shapes).length} shapes from ${profile.hours.length} recorded hours (${profile.bandStartHours.length} bands, ${Math.round(bytes / 1024)} KB)`,
    );
  }
}

async function main() {
  const i = process.argv.indexOf("--feed");
  const only = i >= 0 ? process.argv[i + 1] : undefined;
  const a = process.argv.indexOf("--max-age-h");
  const maxAgeH = a >= 0 ? Number(process.argv[a + 1]) : undefined;
  if (maxAgeH !== undefined && !(maxAgeH > 0))
    throw new Error("--max-age-h takes a number of hours");
  for (const feed of only ? [await readFeed(only)] : await readFeeds())
    if (feed.realtime) await buildFeed(feed, maxAgeH);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
