import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const RAW_DIR = join(ROOT, 'data', 'raw');
export const GTFS_RAW_DIR = join(RAW_DIR, 'gtfs');
export const CONFIG_DIR = join(ROOT, 'data', 'config');
export const PUBLIC_DATA_DIR = join(ROOT, 'public', 'data');
export const FEEDS_OUT_DIR = join(PUBLIC_DATA_DIR, 'feeds');

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

/** Write JSON atomically (temp file + rename) so a crashed build never leaves a half-written file. */
export async function writeJson(path: string, value: unknown, pretty = false): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(value, null, pretty ? 2 : undefined));
  await rename(tmp, path);
}

export function log(...args: unknown[]): void {
  console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...args);
}
