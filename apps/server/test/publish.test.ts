import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MTIME_TOLERANCE_MS, stageCompressed } from "../src/jobs/publish.ts";

describe("stageCompressed", () => {
  let dir: string;
  let from: string;
  let to: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "publish-"));
    from = join(dir, "data");
    to = join(dir, "publish");
    await mkdir(join(from, "feeds/f/v1/trips"), { recursive: true });
    await writeFile(join(from, "feeds/f/manifest.json"), '{"feeds":[]}');
    await writeFile(
      join(from, "feeds/f/v1/trips/1.json"),
      JSON.stringify({ start: [1, 2, 3] }),
    );
    await writeFile(
      join(from, "feeds/f/v1/tracks.geojson"),
      '{"type":"FeatureCollection","features":[]}',
    );
    await writeFile(join(from, "export.ndjson.gz"), "gzipped");
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("writes a brotli copy of each JSON and GeoJSON file, with its source's time", async () => {
    expect(await stageCompressed(from, to)).toEqual({
      compressed: 3,
      unchanged: 0,
      removed: 0,
    });
    for (const rel of [
      "feeds/f/manifest.json",
      "feeds/f/v1/trips/1.json",
      "feeds/f/v1/tracks.geojson",
    ]) {
      expect(brotliDecompressSync(await readFile(join(to, rel)))).toEqual(
        await readFile(join(from, rel)),
      );
      const drift =
        (await stat(join(to, rel))).mtimeMs
        - (await stat(join(from, rel))).mtimeMs;
      expect(Math.abs(drift)).toBeLessThan(MTIME_TOLERANCE_MS);
    }
    await expect(stat(join(to, "export.ndjson.gz"))).rejects.toThrow();
  });

  it("compresses again only what changed, and removes copies whose source is gone", async () => {
    await stageCompressed(from, to);
    const trips = join(from, "feeds/f/v1/trips/1.json");
    await writeFile(trips, JSON.stringify({ start: [4, 5] }));
    const later = new Date(Date.now() + 60_000);
    await utimes(trips, later, later);
    await rm(join(from, "feeds/f/v1/tracks.geojson"));
    expect(await stageCompressed(from, to)).toEqual({
      compressed: 1,
      unchanged: 1,
      removed: 1,
    });
    expect(
      JSON.parse(
        brotliDecompressSync(
          await readFile(join(to, "feeds/f/v1/trips/1.json")),
        ).toString(),
      ),
    ).toEqual({ start: [4, 5] });
    await expect(stat(join(to, "feeds/f/v1/tracks.geojson"))).rejects.toThrow();
  });

  it("compresses again a file that changed without changing its time", async () => {
    await stageCompressed(from, to);
    const trips = join(from, "feeds/f/v1/trips/1.json");
    const { atime, mtime } = await stat(trips);
    await writeFile(trips, JSON.stringify({ start: [9, 9, 9] }));
    await utimes(trips, atime, mtime);
    expect(await stageCompressed(from, to)).toMatchObject({
      compressed: 1,
      unchanged: 2,
    });
    expect(
      JSON.parse(
        brotliDecompressSync(
          await readFile(join(to, "feeds/f/v1/trips/1.json")),
        ).toString(),
      ),
    ).toEqual({ start: [9, 9, 9] });
  });

  it("removes directories it empties, and leaves no temporary files", async () => {
    await stageCompressed(from, to);
    await rm(join(from, "feeds/f/v1"), { recursive: true });
    expect(await stageCompressed(from, to)).toMatchObject({ removed: 2 });
    await expect(stat(join(to, "feeds/f/v1"))).rejects.toThrow();
    expect(await readdir(join(dir, ".publish-tmp"))).toEqual([]);
  });

  it("with include, stages and removes only the files it names", async () => {
    await stageCompressed(from, to);
    await writeFile(join(from, "feeds/f/places.1.json"), "[]");
    await rm(join(from, "feeds/f/v1/tracks.geojson"));
    expect(
      await stageCompressed(from, to, { include: ["places.*.json"] }),
    ).toEqual({ compressed: 1, unchanged: 0, removed: 0 });
    // Not named, so left for a full publish to remove.
    await stat(join(to, "feeds/f/v1/tracks.geojson"));
  });

  it("fails rather than removing every copy when the source can't be read", async () => {
    await stageCompressed(from, to);
    await expect(stageCompressed(join(dir, "missing"), to)).rejects.toThrow(
      /ENOENT/,
    );
    await stat(join(to, "feeds/f/manifest.json"));
  });
});
