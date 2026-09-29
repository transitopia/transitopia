// Build the local vector basemap: a PMTiles extract of the Protomaps daily planet build clipped to
// Metro Vancouver, plus the fonts and sprites the Protomaps style needs, so the app makes no
// third-party map requests at runtime. See PLAN.md §4.9.
//
//   tsx scripts/tiles.ts            # skip steps whose output already exists
//   tsx scripts/tiles.ts --force    # rebuild everything

import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, chmod, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { promisify } from 'node:util';
import { RAW_DIR, ROOT, log } from './lib/paths.ts';

const run = promisify(execFile);

const PMTILES_VERSION = '1.31.2';
/** Covers UBC to Mission (WCE) and Lonsdale to Newton (R1). [west, south, east, north] */
const BBOX = [-123.32, 49.08, -122.2, 49.42] as const;
const MAXZOOM = 15;
const FONTS = ['Noto Sans Regular', 'Noto Sans Medium', 'Noto Sans Italic'];

const BIN_DIR = join(RAW_DIR, 'bin');
const TILES_DIR = join(ROOT, 'public', 'tiles');
const ASSETS_DIR = join(ROOT, 'public', 'basemap-assets');
const OUT = join(TILES_DIR, 'vancouver.pmtiles');

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { headers: { 'User-Agent': 'skytrain-viz/0.1' } });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}): ${url}`);
  const tmp = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body as WebReadableStream), createWriteStream(tmp));
  await rename(tmp, dest);
}

/** Use `pmtiles` from PATH if present, otherwise fetch the pinned go-pmtiles release. */
async function pmtilesBinary(): Promise<string> {
  try {
    await run('pmtiles', ['version']);
    return 'pmtiles';
  } catch {
    // Not on PATH.
  }
  const bin = join(BIN_DIR, 'pmtiles');
  if (await exists(bin)) return bin;
  const os = { darwin: 'Darwin', linux: 'Linux' }[process.platform as string];
  const arch = { arm64: 'arm64', x64: 'x86_64' }[process.arch as string];
  if (!os || !arch) throw new Error(`No pmtiles binary for ${process.platform}/${process.arch}; install it manually`);
  const name = os === 'Darwin' ? `go-pmtiles-${PMTILES_VERSION}_${os}_${arch}.zip` : `go-pmtiles_${PMTILES_VERSION}_${os}_${arch}.tar.gz`;
  const url = `https://github.com/protomaps/go-pmtiles/releases/download/v${PMTILES_VERSION}/${name}`;
  await mkdir(BIN_DIR, { recursive: true });
  const archive = join(BIN_DIR, name);
  log(`Downloading ${url}`);
  await download(url, archive);
  await run('tar', ['-xf', archive, '-C', BIN_DIR, 'pmtiles']); // bsdtar (macOS) also reads zip
  await chmod(bin, 0o755);
  await rm(archive);
  return bin;
}

/** Most recent daily planet build (they appear some hours after midnight UTC). */
async function latestBuildUrl(): Promise<string> {
  for (let back = 0; back < 10; back++) {
    const d = new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10).replaceAll('-', '');
    const url = `https://build.protomaps.com/${d}.pmtiles`;
    const res = await fetch(url, { method: 'HEAD' });
    if (res.ok) return url;
  }
  throw new Error('No Protomaps build found in the last 10 days');
}

async function buildTiles(force: boolean): Promise<void> {
  if (!force && (await exists(OUT))) {
    log(`Tiles exist: ${OUT} (use --force to rebuild)`);
    return;
  }
  const bin = await pmtilesBinary();
  const src = await latestBuildUrl();
  await mkdir(TILES_DIR, { recursive: true });
  log(`Extracting Metro Vancouver from ${src} (maxzoom ${MAXZOOM})…`);
  const tmp = `${OUT}.part`;
  await rm(tmp, { force: true });
  await run(bin, ['extract', src, tmp, `--bbox=${BBOX.join(',')}`, `--maxzoom=${MAXZOOM}`], {
    maxBuffer: 64 * 1024 * 1024,
  });
  await rename(tmp, OUT);
  log(`Wrote ${OUT} (${((await stat(OUT)).size / 1e6).toFixed(1)} MB)`);
}

async function buildAssets(force: boolean): Promise<void> {
  const marker = join(ASSETS_DIR, 'sprites', 'v4', 'light.json');
  if (!force && (await exists(marker))) {
    log(`Basemap assets exist: ${ASSETS_DIR}`);
    return;
  }
  const tarball = join(RAW_DIR, 'basemaps-assets.tar.gz');
  await mkdir(RAW_DIR, { recursive: true });
  log('Downloading protomaps/basemaps-assets');
  await download('https://codeload.github.com/protomaps/basemaps-assets/tar.gz/refs/heads/main', tarball);
  const staging = join(RAW_DIR, 'basemaps-assets');
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  await run('tar', ['-xzf', tarball, '-C', staging, '--strip-components=1']);
  await rm(ASSETS_DIR, { recursive: true, force: true });
  await mkdir(join(ASSETS_DIR, 'fonts'), { recursive: true });
  await mkdir(join(ASSETS_DIR, 'sprites'), { recursive: true });
  for (const font of FONTS) await rename(join(staging, 'fonts', font), join(ASSETS_DIR, 'fonts', font));
  await rename(join(staging, 'sprites', 'v4'), join(ASSETS_DIR, 'sprites', 'v4'));
  await rm(staging, { recursive: true, force: true });
  await rm(tarball);
  const n = (await readdir(join(ASSETS_DIR, 'fonts', FONTS[0]!))).length;
  log(`Installed ${FONTS.length} fonts (${n} glyph ranges each) and v4 sprites into ${ASSETS_DIR}`);
}

async function main() {
  const force = process.argv.includes('--force');
  await buildAssets(force);
  await buildTiles(force);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
