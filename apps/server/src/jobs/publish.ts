// Publishing var/public/data to object storage (deployment/README.md#transit-data-datatransitopiaorg).
// Text files are uploaded compressed with brotli at its highest quality and stored with
// `Content-Encoding: br`: Cloudflare's own compression of them is much weaker (about quality 4,
// or zstd for browsers that accept it), and `no-transform` keeps it from re-encoding ours.
// The compressed copies are staged in var/publish/data with their sources' modification times; a
// copy that still decompresses to its source is neither compressed nor uploaded again.

import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, brotliDecompress, constants } from "node:zlib";
import { PUBLIC_DATA_DIR, PUBLISH_DATA_DIR } from "@transitopia/data/paths.ts";
import { run } from "@transitopia/data/exec.ts";

/** Extensions of the files uploaded compressed; anything else (the features export is already gzipped) goes as it is. */
const COMPRESSED_EXTENSIONS = ["json", "geojson", "bin"];
const COMPRESSED = COMPRESSED_EXTENSIONS.map((ext) => `*.${ext}`);
const isCompressed = (name: string) =>
  COMPRESSED_EXTENSIONS.some((ext) => name.endsWith(`.${ext}`));

/** Files clients poll to find the current version of the rest: published last, with a short cache. */
const POINTERS = ["manifest.json", "places.json", "latest.json", "index.json"];
/** Pointers to a build's files, which only a whole publish uploads (a partial one may not have their files). */
const BUILD_POINTERS = ["manifest.json", "index.json"];

/**
 * Compressions at once in the server. They run on libuv's thread pool (4 threads by default), which
 * the server shares with its file system work, so not all of it. The CLI passes more.
 */
const SERVER_CONCURRENCY = 2;

/**
 * How far a staged copy's time may be from its source's: utimes sets a time in seconds as a double,
 * which keeps less than a microsecond.
 */
export const MTIME_TOLERANCE_MS = 0.001;

const compress = promisify(brotliCompress);
const decompress = promisify(brotliDecompress);

export interface StageOptions {
  /** Only these files (rclone-style name patterns, matched anywhere: `places.*.json`). */
  include?: string[] | undefined;
  /** Compressions at once. */
  concurrency?: number | undefined;
}

export interface StageResult {
  compressed: number;
  unchanged: number;
  removed: number;
}

/**
 * Write a brotli copy (quality 11) of each JSON, GeoJSON and .bin file under `from` to the same path under
 * `to`, with its source's modification time, skipping those whose copy already decompresses to the
 * source, and remove copies whose source is gone. With `include`, only the files it names are
 * staged or removed. Copies are written beside `to` and renamed into place, so a concurrent upload
 * never reads a partial one.
 */
export async function stageCompressed(
  from = PUBLIC_DATA_DIR,
  to = PUBLISH_DATA_DIR,
  { include, concurrency = SERVER_CONCURRENCY }: StageOptions = {},
): Promise<StageResult> {
  const included = include ? nameMatcher(include) : () => true;
  const selected = (rel: string) => isCompressed(rel) && included(rel);
  const sources = (await listFiles(from)).filter(selected);
  const wanted = new Set(sources);
  const tmp = join(dirname(to), `.${basename(to)}-tmp`);
  const result: StageResult = { compressed: 0, unchanged: 0, removed: 0 };
  let next = 0;
  const worker = async () => {
    while (next < sources.length) {
      const rel = sources[next++]!;
      const src = join(from, rel);
      const dest = join(to, rel);
      const { atimeMs, mtimeMs } = await stat(src);
      const data = await readFile(src);
      const staged = await readFile(dest).catch(ifMissing(undefined));
      if (staged && (await decompress(staged)).equals(data)) {
        const { mtimeMs: stagedMs } = await stat(dest);
        if (Math.abs(stagedMs - mtimeMs) >= MTIME_TOLERANCE_MS)
          await utimes(dest, atimeMs / 1000, mtimeMs / 1000);
        result.unchanged++;
        continue;
      }
      const out = await compress(data, {
        params: {
          [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
          [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
          [constants.BROTLI_PARAM_SIZE_HINT]: data.length,
        },
      });
      await mkdir(tmp, { recursive: true });
      const part = join(tmp, `${process.pid}-${tmpSeq++}`);
      try {
        await writeFile(part, out);
        await utimes(part, atimeMs / 1000, mtimeMs / 1000);
        await mkdir(dirname(dest), { recursive: true });
        // Another publisher may remove the directory once it's empty: make it again.
        await rename(part, dest).catch(async (err: unknown) => {
          if (!isMissing(err)) throw err;
          await mkdir(dirname(dest), { recursive: true });
          await rename(part, dest);
        });
      } finally {
        await rm(part, { force: true });
      }
      result.compressed++;
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  for (const rel of await listFiles(to, { missingOk: true }))
    if (selected(rel) && !wanted.has(rel)) {
      await rm(join(to, rel));
      await removeEmptyDirs(dirname(join(to, rel)), to);
      result.removed++;
    }
  return result;
}

let tmpSeq = 0;

export interface PublishOptions {
  /** Only these files, as rclone filters (and the pointers among them). */
  include?: string[] | undefined;
  log?: ((msg: string) => void) | undefined;
  /** Compressions at once (default: what the server can spare). */
  concurrency?: number | undefined;
}

/**
 * Publish var/public/data (or only the files `include` names, as rclone filters) to `remote`.
 * Everything but the pointers first, so no client reads a manifest or index pointing at files that
 * aren't there yet; old files stay for clients holding an older pointer (copy, not sync). The
 * filters name a file anywhere: every feed's data/feeds/<feed>/manifest.json.
 */
export async function publishData(
  remote: string,
  { include, log, concurrency }: PublishOptions = {},
): Promise<void> {
  const pointers =
    include ? POINTERS.filter((p) => !BUILD_POINTERS.includes(p)) : POINTERS;
  const staged = await stageCompressed(PUBLIC_DATA_DIR, PUBLISH_DATA_DIR, {
    include: include && [...include, ...pointers],
    concurrency,
  });
  log?.(
    `compressed ${staged.compressed} files for upload (${staged.unchanged} unchanged, ${staged.removed} removed)`,
  );
  const dest = `${remote}/data`;
  const filters = (names: string[], flag: string) =>
    names.flatMap((n) => [flag, n]);
  const only = include ? filters(include, "--include") : [];
  // --no-update-modtime: for a file whose content is unchanged but whose time is newer (a rebuild
  // that wrote the same bytes), rclone would otherwise set the time by copying the object onto
  // itself with replaced metadata, which drops Content-Encoding and Cache-Control: browsers then
  // got brotli bytes as JSON (2026-10-20).
  const copy = (from: string, maxAge: number, args: string[], br: boolean) =>
    run("rclone", [
      "copy",
      from,
      dest,
      "--no-update-modtime",
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
  await copy(PUBLISH_DATA_DIR, 300, filters(pointers, "--include"), true);
}

/**
 * Whether a relative path's file name matches one of `patterns`: rclone filters without a `/`,
 * which match a name at any depth, with `*` and `?` as wildcards.
 */
function nameMatcher(patterns: string[]): (rel: string) => boolean {
  const regexes = patterns.map((p) => {
    if (/[/[\]{}\\]/.test(p))
      throw new Error(`unsupported publish filter: ${p}`);
    const body = p
      .split("")
      .map((c) =>
        c === "*" ? "[^/]*"
        : c === "?" ? "[^/]"
        : c.replace(/[.+^$()|]/g, "\\$&"),
      )
      .join("");
    return new RegExp(`^${body}$`);
  });
  return (rel) => {
    const name = basename(rel);
    return regexes.some((r) => r.test(name));
  };
}

/** Every file under `dir`, as paths relative to it; with `missingOk`, [] when `dir` doesn't exist. */
async function listFiles(
  dir: string,
  { missingOk = false } = {},
): Promise<string[]> {
  const entries = await readdir(dir, {
    recursive: true,
    withFileTypes: true,
  }).catch(missingOk ? ifMissing([]) : rethrow);
  return entries
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)))
    .sort();
}

/** Remove `dir` and its parents, up to but not including `root`, while they're empty. */
async function removeEmptyDirs(dir: string, root: string): Promise<void> {
  for (; dir !== root && relative(root, dir) !== ""; dir = dirname(dir)) {
    const removed = await rmdir(dir).then(
      () => true,
      (err: unknown) => {
        if (
          isMissing(err)
          || (err as NodeJS.ErrnoException).code === "ENOTEMPTY"
        )
          return false;
        throw err;
      },
    );
    if (!removed) return;
  }
}

const isMissing = (err: unknown) =>
  (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

/** A catch handler that turns a missing file into `value` and rethrows anything else. */
const ifMissing =
  <T>(value: T) =>
  (err: unknown): T => {
    if (isMissing(err)) return value;
    throw err;
  };

const rethrow = (err: unknown): never => {
  throw err;
};
