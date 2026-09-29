// Appends each snapshot to hourly NDJSON files and maintains a coverage index (PLAN.md §4.6):
//   data/rt-history/YYYY-MM-DD/HH.ndjson      (current hour, appended)
//   data/rt-history/YYYY-MM-DD/HH.ndjson.gz   (closed hours, compressed)
//   data/rt-history/coverage.json             ({ intervals: [[startMs, endMs], ...] })
// Dates and hours are local (America/Vancouver) time of the fetch.

import { createReadStream, createWriteStream } from "node:fs";
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip, gunzipSync } from "node:zlib";
import {
  decodeSnapshot,
  encodeSnapshot,
  extendCoverage,
  type RtSnapshot,
} from "@transitopia/transit-core/rt/types.ts";
import { toWallTime } from "@transitopia/transit-core/time.ts";

export function hourKey(t: number): { date: string; hour: string } {
  const w = toWallTime(t);
  return {
    date: `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`,
    hour: String(w.hour).padStart(2, "0"),
  };
}

export class Recorder {
  private intervals: [number, number][] = [];
  private currentFile: string | undefined;
  private loaded = false;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    readonly dir: string,
    /** Coverage continues across gaps up to this (ms), fixed or depending on the time. */
    private gapMs: number | ((t: number) => number),
  ) {}

  private get coveragePath(): string {
    return join(this.dir, "coverage.json");
  }

  async init(): Promise<void> {
    if (this.loaded) return;
    await mkdir(this.dir, { recursive: true });
    try {
      const raw = JSON.parse(await readFile(this.coveragePath, "utf8")) as {
        intervals?: [number, number][];
      };
      this.intervals = raw.intervals ?? [];
    } catch {
      this.intervals = [];
    }
    this.loaded = true;
    await this.compressClosedHours();
  }

  coverage(from = -Infinity, to = Infinity): [number, number][] {
    return this.intervals
      .filter(([a, b]) => b >= from && a <= to)
      .map(([a, b]) => [a, b]);
  }

  /** Queue a snapshot for writing; writes are serialised. */
  record(s: RtSnapshot): Promise<void> {
    this.writing = this.writing
      .then(() => this.write(s))
      .catch((e) => console.error("[rt] recorder error:", e));
    return this.writing;
  }

  private async write(s: RtSnapshot): Promise<void> {
    await this.init();
    const { date, hour } = hourKey(s.fetchedAt);
    const dayDir = join(this.dir, date);
    const file = join(dayDir, `${hour}.ndjson`);
    if (this.currentFile !== file) {
      await mkdir(dayDir, { recursive: true });
      const previous = this.currentFile;
      this.currentFile = file;
      if (previous) await this.compress(previous);
    }
    await appendFile(file, `${encodeSnapshot(s)}\n`);
    extendCoverage(
      this.intervals,
      s.fetchedAt,
      typeof this.gapMs === "number" ? this.gapMs : this.gapMs(s.fetchedAt),
    );
    const tmp = `${this.coveragePath}.tmp`;
    await writeFile(tmp, JSON.stringify({ intervals: this.intervals }));
    await rename(tmp, this.coveragePath);
  }

  private async compress(file: string): Promise<void> {
    try {
      await stat(file);
    } catch {
      return;
    }
    await pipeline(
      createReadStream(file),
      createGzip(),
      createWriteStream(`${file}.gz.tmp`),
    );
    await rename(`${file}.gz.tmp`, `${file}.gz`);
    await rm(file);
  }

  /** On startup, compress any hour files other than the current hour. */
  private async compressClosedHours(): Promise<void> {
    const { date, hour } = hourKey(Date.now());
    const current = join(this.dir, date, `${hour}.ndjson`);
    let days: string[] = [];
    try {
      days = (await readdir(this.dir)).filter((d) =>
        /^\d{4}-\d{2}-\d{2}$/.test(d),
      );
    } catch {
      return;
    }
    for (const d of days) {
      for (const f of await readdir(join(this.dir, d))) {
        const p = join(this.dir, d, f);
        if (f.endsWith(".ndjson") && p !== current) await this.compress(p);
      }
    }
  }

  /** Path and encoding of an hour file, if it exists. */
  async hourFile(
    date: string,
    hour: string,
  ): Promise<{ path: string; gzip: boolean } | undefined> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}$/.test(hour))
      return undefined;
    const base = join(this.dir, date, `${hour}.ndjson`);
    for (const [path, gzip] of [
      [`${base}.gz`, true],
      [base, false],
    ] as const) {
      try {
        await stat(path);
        return { path, gzip };
      } catch {
        // Try the next form.
      }
    }
    return undefined;
  }

  /** The latest recorded snapshot from this hour or the previous one, e.g. to serve after a restart. */
  async lastSnapshot(now = Date.now()): Promise<RtSnapshot | undefined> {
    for (const t of [now, now - 3_600_000]) {
      const { date, hour } = hourKey(t);
      const f = await this.hourFile(date, hour);
      if (!f) continue;
      let lines: string[];
      try {
        const buf = await readFile(f.path);
        lines = (f.gzip ? gunzipSync(buf) : buf)
          .toString("utf8")
          .split("\n")
          .filter(Boolean);
      } catch {
        continue;
      }
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          return decodeSnapshot(lines[i]!);
        } catch {
          // A partly written line (the process stopped mid-write): use the one before.
        }
      }
    }
    return undefined;
  }
}
