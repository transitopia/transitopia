// What the cycling map needs from OpenStreetMap (packages/cycling-core/README.md#building-the-tiles):
// download the area's extract (config/cycling/cycling.json → area.extract: Geofabrik's daily extract
// of British Columbia, about 1.3 GB), checked against Geofabrik's .md5, keep its cycling ways, bike
// parking and bike routes with osmium (OSM_FILTERS) and add the ways' node locations, and write them
// as gzipped OPL: var/raw/osm-cycling/<area>/<date>-<sha256 prefix>.opl.gz (about 20 MB) and
// latest.json pointing at it. GitHub Actions runs this daily and publishes the result (.github/workflows/build_cycling.yml),
// so building the tiles needs neither the extract nor osmium (pipelines/fetch-cycling-osm.ts).
// Needs osmium-tool (OSMIUM names it if it isn't on the PATH) and about 2.5 GB of memory.
//
//   tsx pipelines/extract-cycling-osm.ts                          # download the extract, then filter it
//   tsx pipelines/extract-cycling-osm.ts --extract <file.osm.pbf> # filter an extract already on disk
//
// OSM data © OpenStreetMap contributors, ODbL.

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { createGzip } from "node:zlib";
import { OSM_FILTERS } from "@transitopia/cycling-core/classify.ts";
import {
  pruneExtracts,
  writeCyclingOsmPointer,
} from "@transitopia/data/osm-extracts.ts";
import { extractTimestamp, osmium } from "@transitopia/data/osmium.ts";
import {
  cyclingPaths,
  log,
  readCyclingConfig,
} from "@transitopia/data/paths.ts";

/** Downloaded extracts kept per area: they're large, and the OPL files are what's kept. */
const KEEP_EXTRACTS = 1;
/** Cycling OPL files kept per area, newest first. */
const KEEP_OPL = 2;

/** A transform that hashes what passes through. */
function hashing(hash: ReturnType<typeof createHash>): Transform {
  return new Transform({
    transform(chunk: Buffer, _enc, done) {
      hash.update(chunk);
      done(null, chunk);
    },
  });
}

/** Download the extract (the URL redirects to a dated file, its checksum beside it); its path. */
async function download(url: string, dir: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
  const md5Res = await fetch(`${res.url}.md5`);
  if (!md5Res.ok) throw new Error(`${res.url}.md5: HTTP ${md5Res.status}`);
  const expected = (await md5Res.text()).trim().split(/\s+/)[0];

  await mkdir(dir, { recursive: true });
  // osmium reads the format from the extension.
  const tmp = join(dir, `download.${process.pid}.tmp.osm.pbf`);
  try {
    log(`downloading ${res.url}`);
    const hash = createHash("md5");
    await pipeline(
      Readable.fromWeb(res.body as WebReadableStream<Uint8Array>),
      hashing(hash),
      createWriteStream(tmp),
    );
    const actual = hash.digest("hex");
    if (actual !== expected)
      throw new Error(`${res.url}: md5 ${actual}, expected ${expected}`);
    const date = (await extractTimestamp(tmp)).slice(0, 10);
    const path = join(dir, `${date}.osm.pbf`);
    await rename(tmp, path);
    return path;
  } finally {
    await rm(tmp, { force: true });
  }
}

async function main() {
  const i = process.argv.indexOf("--extract");
  const { area } = await readCyclingConfig();
  const paths = cyclingPaths(area.id);
  const extract =
    i >= 0 ?
      process.argv[i + 1]!
    : await download(area.extract, paths.extracts);
  const osmTimestamp = await extractTimestamp(extract);
  log(`${area.id}: ${extract} (${osmTimestamp})`);

  await mkdir(paths.osm, { recursive: true });
  const tmp = join(paths.osm, `extract.${process.pid}.tmp`);
  const filtered = `${tmp}.osm.pbf`;
  const opl = `${tmp}.opl`;
  const gz = `${tmp}.opl.gz`;
  try {
    const t = Date.now();
    await osmium([
      "tags-filter",
      extract,
      ...OSM_FILTERS,
      "--overwrite",
      `--output=${filtered}`,
    ]);
    await osmium([
      "add-locations-to-ways",
      filtered,
      "--overwrite",
      "--output-format=opl,add_metadata=false",
      `--output=${opl}`,
    ]);
    const hash = createHash("sha256");
    await pipeline(
      createReadStream(opl),
      createGzip({ level: 9 }),
      hashing(hash),
      createWriteStream(gz),
    );
    const sha256 = hash.digest("hex");
    const file = `${osmTimestamp.slice(0, 10)}-${sha256.slice(0, 8)}.opl.gz`;
    await rename(gz, join(paths.osm, file));
    const { size } = await stat(join(paths.osm, file));
    await writeCyclingOsmPointer(
      paths.osm,
      {
        file,
        osmTimestamp,
        extract: i >= 0 ? basename(extract) : area.extract,
        bytes: size,
        sha256,
        generatedAt: new Date().toISOString(),
      },
      KEEP_OPL,
    );
    log(
      `${area.id}: ${join(paths.osm, file)}, ${(size / 1e6).toFixed(1)} MB (${((Date.now() - t) / 1000).toFixed(0)} s)`,
    );
  } finally {
    for (const f of [filtered, opl, gz]) await rm(f, { force: true });
  }
  if (i < 0) await pruneExtracts(area.id, KEEP_EXTRACTS);
}

await main();
