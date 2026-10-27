// Download the cycling map's OSM extract (config/cycling/cycling.json → area.extract: Geofabrik's daily
// extract of British Columbia, about 1.3 GB), checked against Geofabrik's .md5 and saved by the date
// of its data, so builds are reproducible: var/raw/osm-extracts/<area>/YYYY-MM-DD.osm.pbf. The newest
// KEEP extracts are kept. Needs osmium-tool (to read the date from the extract's header).
//
//   tsx pipelines/fetch-osm-extract.ts                    # always download
//   tsx pipelines/fetch-osm-extract.ts --max-age-days 1   # only if the newest is older than that
//
// OSM data © OpenStreetMap contributors, ODbL.

import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import {
  cyclingPaths,
  log,
  readCyclingConfig,
} from "@transitopia/data/paths.ts";
import { listExtracts } from "@transitopia/data/osm-extracts.ts";
import { extractTimestamp } from "@transitopia/data/osmium.ts";

/** Extracts kept per area, newest first; older ones are deleted after a download. */
const KEEP = 2;
const DAY_MS = 86_400_000;

async function main() {
  const i = process.argv.indexOf("--max-age-days");
  const maxAgeDays = i >= 0 ? Number(process.argv[i + 1]) : undefined;
  const { area } = await readCyclingConfig();
  const dir = cyclingPaths(area.id).extracts;
  const newest = (await listExtracts(area.id))[0];
  if (
    newest
    && maxAgeDays !== undefined
    && Date.now() - Date.parse(newest.date) < maxAgeDays * DAY_MS
  ) {
    log(`${area.id}: ${newest.date} is recent enough; not downloading`);
    return;
  }

  // The URL redirects to a dated file: its checksum is beside it.
  const res = await fetch(area.extract);
  if (!res.ok || !res.body)
    throw new Error(`${area.extract}: HTTP ${res.status}`);
  const md5Res = await fetch(`${res.url}.md5`);
  if (!md5Res.ok) throw new Error(`${res.url}.md5: HTTP ${md5Res.status}`);
  const expected = (await md5Res.text()).trim().split(/\s+/)[0];

  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `download.${process.pid}.tmp`);
  try {
    log(`${area.id}: downloading ${res.url}`);
    const hash = createHash("md5");
    await pipeline(
      Readable.fromWeb(res.body as WebReadableStream<Uint8Array>),
      new Transform({
        transform(chunk: Buffer, _enc, done) {
          hash.update(chunk);
          done(null, chunk);
        },
      }),
      createWriteStream(tmp),
    );
    const actual = hash.digest("hex");
    if (actual !== expected)
      throw new Error(`${res.url}: md5 ${actual}, expected ${expected}`);
    const date = (await extractTimestamp(tmp)).slice(0, 10);
    const path = join(dir, `${date}.osm.pbf`);
    await rename(tmp, path);
    log(`${area.id}: ${path}`);
  } finally {
    await rm(tmp, { force: true });
  }
  for (const old of (await listExtracts(area.id)).slice(KEEP))
    await rm(old.path, { force: true });
}

await main();
