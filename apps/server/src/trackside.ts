// Trackside camera passes (packages/trackside/README.md#reports): what admins' cameras upload while testing.
// With a database they're in trackside_passes and trackside_crops; without one, one JSON file per
// pass under var/trackside/passes/<UTC date>/ and its crops under var/trackside/crops/<pass id>/.
// For now they're only stored and listed (shadow mode); nothing feeds the dispatcher yet.

import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "kysely";
import type { Db } from "@transitopia/db/connect.ts";
import type { PassReport } from "@transitopia/trackside/types.ts";
import { jpegBytes } from "@transitopia/trackside/validate.ts";

export interface CropInfo {
  idx: number;
  reading: string;
  confidence: number;
  accepted: boolean;
  label: string | null;
}

export interface TracksidePass {
  id: string;
  /** The report as sent, without crops. */
  report: PassReport;
  createdBy: string | null;
  receivedAt: string;
  crops: CropInfo[];
}

export interface TracksideStore {
  /**
   * Store a report. Sending one with the same id again (from the same account) replaces it, e.g.
   * when the user corrects its track, but keeps the crops first stored.
   */
  add(
    report: PassReport,
    by: string | undefined,
  ): Promise<"added" | "updated" | "duplicate">;
  /** The latest passes, newest first. */
  list(limit: number): Promise<TracksidePass[]>;
  crop(passId: string, idx: number): Promise<Uint8Array | undefined>;
}

/** The report without crop images, and the crops in reading order (cars, then uncertain). */
function split(report: PassReport): {
  bare: PassReport;
  crops: (CropInfo & { jpeg: Uint8Array })[];
} {
  const crops: (CropInfo & { jpeg: Uint8Array })[] = [];
  const strip = (accepted: boolean) => (c: PassReport["cars"][number]) => {
    const jpeg = c.crop ? jpegBytes(c.crop) : undefined;
    if (jpeg)
      crops.push({
        idx: crops.length,
        reading: c.number,
        confidence: c.confidence,
        accepted,
        label: null,
        jpeg,
      });
    const { crop: _, ...rest } = c;
    return rest;
  };
  return {
    bare: {
      ...report,
      cars: report.cars.map(strip(true)),
      uncertain: report.uncertain?.map(strip(false)),
    },
    crops,
  };
}

export class DbTracksideStore implements TracksideStore {
  private readonly db: Db;
  private readonly regionId: string;

  constructor(db: Db, regionId: string) {
    this.db = db;
    this.regionId = regionId;
  }

  async add(
    report: PassReport,
    by: string | undefined,
  ): Promise<"added" | "updated" | "duplicate"> {
    const { bare, crops } = split(report);
    const row = {
      setup_id: report.setup.id,
      started_at: report.start,
      ended_at: report.end,
      track: report.trackSegment ?? null,
      track_index: report.track ?? null,
      bearing: report.bearing,
      speed_kmh: report.speedKmh,
      cars: report.cars.map((c) => c.number),
      report: JSON.stringify(bare),
    };
    return this.db.transaction().execute(async (tx) => {
      // Same id again from the same account: replace the report (xmax is 0 only on a fresh insert).
      const result = await tx
        .insertInto("trackside_passes")
        .values({
          id: report.id,
          region_id: this.regionId,
          created_by: by ?? null,
          ...row,
        })
        .onConflict((oc) =>
          oc
            .column("id")
            .doUpdateSet(row)
            .where(
              "trackside_passes.created_by",
              "is not distinct from",
              by ?? null,
            ),
        )
        .returning(sql<boolean>`(xmax = 0)`.as("inserted"))
        .executeTakeFirst();
      if (!result) return "duplicate";
      if (!result.inserted) return "updated";
      if (crops.length)
        await tx
          .insertInto("trackside_crops")
          .values(
            crops.map((c) => ({
              pass_id: report.id,
              idx: c.idx,
              reading: c.reading,
              confidence: c.confidence,
              accepted: c.accepted,
              jpeg: Buffer.from(c.jpeg),
            })),
          )
          .execute();
      return "added";
    });
  }

  async list(limit: number): Promise<TracksidePass[]> {
    const rows = await this.db
      .selectFrom("trackside_passes")
      .select(["id", "report", "created_by", "received_at"])
      .where("region_id", "=", this.regionId)
      .orderBy("started_at", "desc")
      .limit(limit)
      .execute();
    if (!rows.length) return [];
    const crops = await this.db
      .selectFrom("trackside_crops")
      .select(["pass_id", "idx", "reading", "confidence", "accepted", "label"])
      .where(
        "pass_id",
        "in",
        rows.map((r) => r.id),
      )
      .orderBy("idx")
      .execute();
    return rows.map((r) => ({
      id: r.id,
      report: r.report as PassReport,
      createdBy: r.created_by,
      receivedAt: r.received_at.toISOString(),
      crops: crops
        .filter((c) => c.pass_id === r.id)
        .map((c) => ({
          idx: c.idx,
          reading: c.reading,
          confidence: c.confidence,
          accepted: c.accepted,
          label: c.label,
        })),
    }));
  }

  async crop(passId: string, idx: number): Promise<Uint8Array | undefined> {
    const row = await this.db
      .selectFrom("trackside_crops")
      .select("jpeg")
      .where("pass_id", "=", passId)
      .where("idx", "=", idx)
      .executeTakeFirst();
    return row?.jpeg;
  }
}

export class FileTracksideStore implements TracksideStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  async add(
    report: PassReport,
    by: string | undefined,
  ): Promise<"added" | "updated" | "duplicate"> {
    const dayDir = join(this.dir, "passes", report.start.slice(0, 10));
    const file = join(dayDir, `${report.id}.json`);
    const { bare, crops } = split(report);
    if (await exists(file)) {
      const old = JSON.parse(await readFile(file, "utf8")) as TracksidePass;
      if (old.createdBy !== (by ?? null)) return "duplicate";
      await writeFile(file, JSON.stringify({ ...old, report: bare }));
      return "updated";
    }
    const cropDir = join(this.dir, "crops", report.id);
    if (crops.length) {
      await mkdir(cropDir, { recursive: true });
      for (const c of crops)
        await writeFile(join(cropDir, `${c.idx}.jpg`), c.jpeg);
    }
    const stored: TracksidePass = {
      id: report.id,
      report: bare,
      createdBy: by ?? null,
      receivedAt: new Date().toISOString(),
      crops: crops.map((c) => ({
        idx: c.idx,
        reading: c.reading,
        confidence: c.confidence,
        accepted: c.accepted,
        label: c.label,
      })),
    };
    await mkdir(dayDir, { recursive: true });
    await writeFile(file, JSON.stringify(stored));
    return "added";
  }

  async list(limit: number): Promise<TracksidePass[]> {
    // Newest day first (directories are YYYY-MM-DD).
    const days = (await readdir(join(this.dir, "passes")).catch(() => [])).sort(
      (a, b) => b.localeCompare(a),
    );
    const out: TracksidePass[] = [];
    for (const day of days) {
      const files = await readdir(join(this.dir, "passes", day));
      for (const f of files.filter((f) => f.endsWith(".json")))
        out.push(
          JSON.parse(
            await readFile(join(this.dir, "passes", day, f), "utf8"),
          ) as TracksidePass,
        );
      if (out.length >= limit) break;
    }
    return out
      .sort((a, b) => (a.report.start < b.report.start ? 1 : -1))
      .slice(0, limit);
  }

  async crop(passId: string, idx: number): Promise<Uint8Array | undefined> {
    return readFile(join(this.dir, "crops", passId, `${idx}.jpg`)).catch(
      () => undefined,
    );
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}
