// Publishing var/public/data to object storage (deployment/README.md#transit-data-datatransitopiaorg).
// Text files are uploaded compressed with brotli at its highest quality and stored with
// `Content-Encoding: br`: Cloudflare's own compression of them is much weaker (about quality 4,
// or zstd for browsers that accept it), and `no-transform` keeps it from re-encoding ours.
// The compressed copies are staged in var/publish/data, each with its source's modification time,
// so a file that hasn't changed is neither compressed nor uploaded again.

import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants } from "node:zlib";
import { PUBLIC_DATA_DIR, PUBLISH_DATA_DIR } from "@transitopia/data/paths.ts";
import { run } from "./exec.ts";

/** Files uploaded compressed; anything else (the features export is already gzipped) goes as it is. */
const COMPRESSED = ["*.json", "*.geojson"];
const isCompressed = (name: string) => /\.(geo)?json$/.test(name);

/** Files clients poll to find the current version of the rest: published last, with a short cache. */
const POINTERS = ["manifest.json", "places.json", "latest.json"];

/**
 * Compressions at once. They run on libuv's thread pool (4 threads by default), which the server
 * shares with its file system work, so not all of it.
 */
const CONCURRENCY = 2;

const compress = promisify(brotliCompress);

export interface StageResult {
  compressed: number;
  unchanged: number;
  removed: number;
}

/**
 * Write a brotli copy (quality 11) of each JSON and GeoJSON file under `from` to the same path under
 * `to`, skipping those whose copy has the source's modification time, and remove copies whose
 * source is gone.
 */
export async function stageCompressed(
  from = PUBLIC_DATA_DIR,
  to = PUBLISH_DATA_DIR,
): Promise<StageResult> {
  const sources = (await listFiles(from)).filter(isCompressed);
  const wanted = new Set(sources);
  const result: StageResult = { compressed: 0, unchanged: 0, removed: 0 };
  let next = 0;
  const worker = async () => {
    while (next < sources.length) {
      const rel = sources[next++]!;
      const src = join(from, rel);
      const dest = join(to, rel);
      const { atimeMs, mtimeMs } = await stat(src);
      const staged = await stat(dest).catch(() => undefined);
      // utimes sets a time in seconds as a double: it keeps less than a microsecond.
      if (staged && Math.abs(staged.mtimeMs - mtimeMs) < 0.001) {
        result.unchanged++;
        continue;
      }
      const data = await readFile(src);
      const out = await compress(data, {
        params: {
          [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
          [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
          [constants.BROTLI_PARAM_SIZE_HINT]: data.length,
        },
      });
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, out);
      await utimes(dest, atimeMs / 1000, mtimeMs / 1000);
      result.compressed++;
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  for (const rel of await listFiles(to))
    if (!wanted.has(rel)) {
      await rm(join(to, rel));
      result.removed++;
    }
  return result;
}

/**
 * Publish var/public/data (or only the files `include` names, as rclone filters) to `remote`.
 * Everything but the pointers first, so no client reads a manifest or index pointing at files that
 * aren't there yet; old files stay for clients holding an older pointer (copy, not sync). The
 * filters name a file anywhere: every feed's data/feeds/<feed>/manifest.json.
 */
export async function publishData(
  remote: string,
  include?: string[],
  log?: (msg: string) => void,
): Promise<void> {
  const staged = await stageCompressed();
  log?.(
    `compressed ${staged.compressed} files for upload (${staged.unchanged} unchanged, ${staged.removed} removed)`,
  );
  const dest = `${remote}/data`;
  const filters = (names: string[], flag: string) =>
    names.flatMap((n) => [flag, n]);
  const only = include ? filters(include, "--include") : [];
  const copy = (from: string, maxAge: number, args: string[], br: boolean) =>
    run("rclone", [
      "copy",
      from,
      dest,
      ...args,
      "--header-upload",
      `Cache-Control: public, max-age=${maxAge}${br ? ", no-transform" : ""}`,
      ...(br ? ["--header-upload", "Content-Encoding: br"] : []),
      "--s3-no-check-bucket",
    ]);
  const DAY = 86400;
  await copy(
    PUBLISH_DATA_DIR,
    DAY,
    [...filters(POINTERS, "--exclude"), ...only],
    true,
  );
  await copy(
    PUBLIC_DATA_DIR,
    DAY,
    [...filters(COMPRESSED, "--exclude"), ...only],
    false,
  );
  await copy(
    PUBLISH_DATA_DIR,
    300,
    filters(
      include ? POINTERS.filter((p) => p !== "manifest.json") : POINTERS,
      "--include",
    ),
    true,
  );
}

/** Every file under `dir`, as paths relative to it ([] when it doesn't exist). */
async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, {
    recursive: true,
    withFileTypes: true,
  }).catch(() => []);
  return entries
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)))
    .sort();
}
