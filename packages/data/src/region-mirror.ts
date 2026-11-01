// The expand step of moving rail data to data/networks/<id>/ and observations to
// data/feeds/<feed>/observations/ (docs/DESIGN.md#feeds-operators-and-rail-networks): until the site
// reading the new paths is confirmed in production, each such directory is also published where the
// old site reads it, data/regions/<region>/<dir>/, for every region showing the feed. Index files keep
// pointing to the new paths, which the old site fetches as they are.

import { cp, rm } from "node:fs/promises";
import { join } from "node:path";
import { PUBLIC_DATA_DIR, readRegions } from "./paths.ts";

/** Replace data/regions/<region>/<dir>/ with a copy of a published directory, for each region showing `feed`. */
export async function mirrorToRegions(
  feed: string,
  from: string,
  dir: string,
): Promise<void> {
  for (const r of await readRegions())
    if (r.feeds.includes(feed)) {
      const to = join(PUBLIC_DATA_DIR, "regions", r.id, dir);
      await rm(to, { recursive: true, force: true });
      await cp(from, to, { recursive: true });
    }
}
