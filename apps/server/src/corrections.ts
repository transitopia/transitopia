// Corrections: observations and disruptions (docs/DESIGN.md#corrections-and-previews). With a database they live in the
// observation_sets and disruptions tables with a review state (draft → previewing → confirmed |
// discarded); without one, in the files under regions/metro-vancouver/ as before. The live
// dispatcher reads whichever applies through `Corrections`; `export` writes the confirmed ones back
// to the file format (for tests, reproducible bug reports and the static build).

import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  OBSERVATIONS_DIR,
  DISRUPTIONS_DIR,
  readJson,
} from "@transitopia/pipelines/lib/paths.ts";
import {
  datesOf,
  loadDisruptions,
} from "@transitopia/pipelines/lib/disruptions.ts";
import type { Db } from "@transitopia/db/connect.ts";
import type { ReviewState } from "@transitopia/db/schema.ts";
import type {
  Observation,
  ObservationFile,
} from "@transitopia/transit-core/corrections/types.ts";
import { observationProblems } from "@transitopia/transit-core/corrections/validate.ts";
import type {
  Disruption,
  DisruptionFile,
} from "@transitopia/transit-core/disruption/types.ts";

export interface CorrectionInputs {
  observations: Observation[];
  disruptions: Disruption[];
}

/** What the live dispatcher applies: confirmed corrections only. */
export interface Corrections {
  load(): Promise<CorrectionInputs>;
}

export class FileCorrections implements Corrections {
  private readonly observationsDir: string;
  private readonly disruptionsDir: string;
  private readonly log: (msg: string) => void;

  constructor(
    opts: {
      observationsDir?: string | undefined;
      disruptionsDir?: string | undefined;
      log?: (msg: string) => void;
    } = {},
  ) {
    this.observationsDir = opts.observationsDir ?? OBSERVATIONS_DIR;
    this.disruptionsDir = opts.disruptionsDir ?? DISRUPTIONS_DIR;
    this.log = opts.log ?? (() => {});
  }

  async load(): Promise<CorrectionInputs> {
    const [observations, disruptions] = await Promise.all([
      loadObservationFiles(this.observationsDir, this.log),
      loadDisruptions(this.disruptionsDir),
    ]);
    return {
      observations: observations.flatMap((f) => valid(f.file.observations)),
      disruptions: disruptions.filter((d) => d.status !== "draft"),
    };
  }
}

export async function loadObservationFiles(
  dir: string,
  log: (msg: string) => void = () => {},
): Promise<{ id: string; file: ObservationFile }[]> {
  let files: string[] = [];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: { id: string; file: ObservationFile }[] = [];
  for (const f of files.sort()) {
    try {
      out.push({
        id: f.replace(/\.json$/, ""),
        file: await readJson<ObservationFile>(join(dir, f)),
      });
    } catch (e) {
      log(`skipping ${f}: ${(e as Error).message}`);
    }
  }
  return out;
}

/** JSON with sorted keys (jsonb doesn't keep key order). */
function stableJson(v: unknown): string {
  return JSON.stringify(v, (_, x: unknown) =>
    x && typeof x === "object" && !Array.isArray(x) ?
      Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1)))
    : x,
  );
}

const valid = (obs: Observation[]) =>
  obs.filter((o) => !observationProblems(o).length);

/** Service dates (YYYY-MM-DD) an observation file is about. */
export const observationDates = (f: ObservationFile): string[] =>
  [...new Set(f.observations.map((o) => o.date))].sort();

/** Service dates (YYYY-MM-DD) a disruption touches. */
export const disruptionDates = (d: Disruption): string[] =>
  datesOf(d).map((date) => Temporal.PlainDate.from(date).toString());

export interface ObservationSetRow {
  id: string;
  region_id: string;
  state: ReviewState;
  title: string;
  body: ObservationFile;
  dates: string[];
  created_at: Date;
  updated_at: Date;
  created_by: string | null;
  reviewed_by: string | null;
  reviewed_at: Date | null;
}

export interface DisruptionRow {
  id: string;
  region_id: string;
  state: ReviewState;
  body: Disruption;
  dates: string[];
  alert_id: string | null;
  created_at: Date;
  updated_at: Date;
  created_by: string | null;
  reviewed_by: string | null;
  reviewed_at: Date | null;
}

/** Corrections in the database: what the dispatcher applies, and the admin's review queue. */
export class CorrectionsRepo implements Corrections {
  readonly db: Db;
  readonly regionId: string;

  constructor(db: Db, regionId: string) {
    this.db = db;
    this.regionId = regionId;
  }

  async load(): Promise<CorrectionInputs> {
    const [sets, disruptions] = await Promise.all([
      this.observationSets(["confirmed"]),
      this.disruptions(["confirmed"]),
    ]);
    // In id order, as files are read in name order: the same inputs give the same dispatch version.
    const byId = (a: { id: string }, b: { id: string }) =>
      a.id < b.id ? -1
      : a.id > b.id ? 1
      : 0;
    sets.sort(byId);
    disruptions.sort(byId);
    return {
      observations: sets.flatMap((s) => valid(s.body.observations)),
      disruptions: disruptions.map((d) => ({ ...d.body, status: "confirmed" })),
    };
  }

  async observationSets(states?: ReviewState[]): Promise<ObservationSetRow[]> {
    let q = this.db
      .selectFrom("observation_sets")
      .selectAll()
      .where("region_id", "=", this.regionId);
    if (states) q = q.where("state", "in", states);
    const rows = await q.orderBy("updated_at", "desc").execute();
    return rows.map((r) => ({
      ...r,
      body: r.body as ObservationFile,
    }));
  }

  async disruptions(states?: ReviewState[]): Promise<DisruptionRow[]> {
    let q = this.db
      .selectFrom("disruptions")
      .selectAll()
      .where("region_id", "=", this.regionId);
    if (states) q = q.where("state", "in", states);
    const rows = await q.orderBy("updated_at", "desc").execute();
    return rows.map((r) => ({
      ...r,
      body: r.body as Disruption,
    }));
  }

  async observationSet(id: string): Promise<ObservationSetRow | undefined> {
    return (await this.observationSets()).find((s) => s.id === id);
  }

  async disruption(id: string): Promise<DisruptionRow | undefined> {
    return (await this.disruptions()).find((d) => d.id === id);
  }

  /** Create or replace an observation set (its content; the state is kept unless given). */
  async saveObservationSet(
    id: string,
    body: ObservationFile,
    opts: {
      title?: string | undefined;
      state?: ReviewState | undefined;
      by?: string | undefined;
    } = {},
  ): Promise<void> {
    const now = new Date();
    const title = opts.title ?? body.$comment?.slice(0, 200) ?? id;
    await this.db
      .insertInto("observation_sets")
      .values({
        id,
        region_id: this.regionId,
        state: opts.state ?? "draft",
        title,
        body: JSON.stringify(body),
        dates: observationDates(body),
        created_by: opts.by ?? null,
        reviewed_by: null,
        reviewed_at: null,
      })
      .onConflict((oc) =>
        oc.column("id").doUpdateSet({
          title,
          body: JSON.stringify(body),
          dates: observationDates(body),
          updated_at: now,
          ...(opts.state ? { state: opts.state } : {}),
        }),
      )
      .execute();
  }

  /** Create or replace a disruption (its content; the state is kept unless given). */
  async saveDisruption(
    d: Disruption,
    opts: { state?: ReviewState | undefined; by?: string | undefined } = {},
  ): Promise<void> {
    const { status: _, ...body } = d;
    const now = new Date();
    await this.db
      .insertInto("disruptions")
      .values({
        id: d.id,
        region_id: this.regionId,
        state: opts.state ?? (d.status === "confirmed" ? "confirmed" : "draft"),
        body: JSON.stringify(body),
        dates: disruptionDates(d),
        alert_id: d.alertId ?? null,
        created_by: opts.by ?? null,
        reviewed_by: null,
        reviewed_at: null,
      })
      .onConflict((oc) =>
        oc.column("id").doUpdateSet({
          body: JSON.stringify(body),
          dates: disruptionDates(d),
          alert_id: d.alertId ?? null,
          updated_at: now,
          ...(opts.state ? { state: opts.state } : {}),
        }),
      )
      .execute();
  }

  /**
   * A disruption drafted from an alert: added as a draft unless it's known already (a person's
   * version, confirmed or discarded, wins); an unreviewed draft is refreshed with the alert's wording.
   * Returns whether anything changed.
   */
  async saveAlertDraft(d: Disruption): Promise<boolean> {
    const existing = await this.disruption(d.id);
    if (existing && existing.state !== "draft") return false;
    const { status: _, ...body } = d;
    if (existing && stableJson(existing.body) === stableJson(body))
      return false;
    await this.saveDisruption(
      { ...d, status: "draft" },
      { state: "draft", by: "TransLink alert" },
    );
    return true;
  }

  async setState(
    kind: "observations" | "disruption",
    id: string,
    state: ReviewState,
    by: string,
  ): Promise<boolean> {
    const table = kind === "observations" ? "observation_sets" : "disruptions";
    const now = new Date();
    const r = await this.db
      .updateTable(table)
      .set({
        state,
        updated_at: now,
        ...(state === "confirmed" || state === "discarded" ?
          { reviewed_by: by, reviewed_at: now }
        : {}),
      })
      .where("id", "=", id)
      .where("region_id", "=", this.regionId)
      .executeTakeFirst();
    return Number(r.numUpdatedRows) > 0;
  }

  /** Import the committed files (idempotent: existing ids are left as they are). */
  async importFiles(
    observationsDir = OBSERVATIONS_DIR,
    disruptionsDir = DISRUPTIONS_DIR,
  ): Promise<{ observationSets: number; disruptions: number }> {
    let observationSets = 0;
    let disruptions = 0;
    const knownSets = new Set((await this.observationSets()).map((s) => s.id));
    for (const { id, file } of await loadObservationFiles(observationsDir)) {
      if (knownSets.has(id)) continue;
      await this.saveObservationSet(id, file, {
        state: "confirmed",
        by: "import",
      });
      observationSets++;
    }
    const knownDisruptions = new Set(
      (await this.disruptions()).map((d) => d.id),
    );
    for (const d of await loadDisruptions(disruptionsDir)) {
      if (knownDisruptions.has(d.id)) continue;
      await this.saveDisruption(d, {
        state: d.status === "draft" ? "draft" : "confirmed",
        by: "import",
      });
      disruptions++;
    }
    return { observationSets, disruptions };
  }

  /**
   * Write the confirmed corrections as files: <dir>/observations/<id>.json and
   * <dir>/disruptions/<id>.json (the formats in regions/metro-vancouver/*\/README.md). The
   * directories are replaced, so they hold exactly what's confirmed.
   */
  async exportFiles(
    dir: string,
  ): Promise<{ observationSets: number; disruptions: number }> {
    const obsDir = join(dir, "observations");
    const disDir = join(dir, "disruptions");
    await rm(obsDir, { recursive: true, force: true });
    await rm(disDir, { recursive: true, force: true });
    await mkdir(obsDir, { recursive: true });
    await mkdir(disDir, { recursive: true });
    const sets = await this.observationSets(["confirmed"]);
    for (const s of sets)
      await writeFile(
        join(obsDir, `${s.id}.json`),
        JSON.stringify(s.body, null, 2) + "\n",
      );
    const disruptions = await this.disruptions(["confirmed"]);
    for (const d of disruptions) {
      const file: DisruptionFile = {
        $comment: `Exported from the database; confirmed by ${d.reviewed_by ?? "?"}${d.reviewed_at ? ` on ${d.reviewed_at.toISOString().slice(0, 10)}` : ""}.`,
        disruptions: [{ ...d.body, status: "confirmed" }],
      };
      await writeFile(
        join(disDir, `${d.id}.json`),
        JSON.stringify(file, null, 2) + "\n",
      );
    }
    return { observationSets: sets.length, disruptions: disruptions.length };
  }
}
