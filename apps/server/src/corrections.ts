// Corrections: observations (docs/DESIGN.md#corrections), in the observation_sets table. Each set
// applies as soon as it's saved: the live dispatcher reads them through `Corrections`; `importFiles`
// brings in the committed files (TransLink's observations in config/feeds/translink/observations/),
// and `export` writes them back to that format (for tests, reproducible bug reports and the static
// build).

import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  correctionPaths,
  readJson,
  type RailNetwork,
} from "@transitopia/data/paths.ts";
import type { Db } from "@transitopia/db/connect.ts";
import type { ObservationRow } from "@transitopia/shared/admin-api.ts";
import type {
  Observation,
  ObservationFile,
} from "@transitopia/transit-core/corrections/types.ts";
import { observationProblems } from "@transitopia/transit-core/corrections/validate.ts";

export interface CorrectionInputs {
  observations: Observation[];
}

/** What the live dispatcher applies. */
export interface Corrections {
  load(): Promise<CorrectionInputs>;
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

const valid = (obs: Observation[]) =>
  obs.filter((o) => !observationProblems(o).length);

/** Service dates (YYYY-MM-DD) an observation file is about. */
export const observationDates = (f: ObservationFile): string[] =>
  [...new Set(f.observations.map((o) => o.date))].sort();

/** A row as the admin API sends it, with the columns it leaves out. */
type Stored<T> = T & { created_at: Date };
export type ObservationSetRow = Stored<ObservationRow> & { feed_id: string };

/** Corrections in the database, which the dispatcher applies. A rail network's: its feed's observations. */
export class CorrectionsRepo implements Corrections {
  readonly db: Db;
  readonly net: RailNetwork;

  constructor(db: Db, net: RailNetwork) {
    this.db = db;
    this.net = net;
  }

  async load(): Promise<CorrectionInputs> {
    const sets = await this.observationSets();
    // In id order, as files are read in name order: the same inputs give the same dispatch version.
    sets.sort((a, b) =>
      a.id < b.id ? -1
      : a.id > b.id ? 1
      : 0,
    );
    return { observations: sets.flatMap((s) => valid(s.body.observations)) };
  }

  async observationSets(): Promise<ObservationSetRow[]> {
    const rows = await this.db
      .selectFrom("observation_sets")
      .selectAll()
      .where("feed_id", "=", this.net.feed)
      .orderBy("updated_at", "desc")
      .execute();
    return rows.map((r) => ({
      ...r,
      body: r.body as ObservationFile,
    }));
  }

  async observationSet(id: string): Promise<ObservationSetRow | undefined> {
    return (await this.observationSets()).find((s) => s.id === id);
  }

  /** Create or replace an observation set; it applies at the dispatcher's next check. */
  async saveObservationSet(
    id: string,
    body: ObservationFile,
    opts: { title?: string | undefined; by?: string | undefined } = {},
  ): Promise<void> {
    const now = new Date();
    const title = opts.title ?? body.$comment?.slice(0, 200) ?? id;
    await this.db
      .insertInto("observation_sets")
      .values({
        id,
        feed_id: this.net.feed,
        title,
        body: JSON.stringify(body),
        dates: observationDates(body),
        created_by: opts.by ?? null,
      })
      .onConflict((oc) =>
        oc.column("id").doUpdateSet({
          title,
          body: JSON.stringify(body),
          dates: observationDates(body),
          updated_at: now,
        }),
      )
      .execute();
  }

  async deleteObservationSet(id: string): Promise<boolean> {
    const r = await this.db
      .deleteFrom("observation_sets")
      .where("id", "=", id)
      .where("feed_id", "=", this.net.feed)
      .executeTakeFirst();
    return Number(r.numDeletedRows) > 0;
  }

  /**
   * Import correction files from a directory laid out like config/ (correctionPaths; default: the
   * committed files). Idempotent: existing ids are left as they are.
   */
  async importFiles(root?: string): Promise<{ observationSets: number }> {
    const { observations: observationsDir } = correctionPaths(this.net, root);
    let observationSets = 0;
    const knownSets = new Set((await this.observationSets()).map((s) => s.id));
    for (const { id, file } of await loadObservationFiles(observationsDir)) {
      if (knownSets.has(id)) continue;
      await this.saveObservationSet(id, file, { by: "import" });
      observationSets++;
    }
    return { observationSets };
  }

  /**
   * Write the corrections as files under `root`, laid out like config/ (correctionPaths):
   * feeds/<feed>/observations/<id>.json (the format in config/feeds/translink/observations/README.md).
   * The directory is replaced, so it holds exactly what's in the database.
   */
  async exportFiles(root: string): Promise<{ observationSets: number }> {
    const { observations: obsDir } = correctionPaths(this.net, root);
    await rm(obsDir, { recursive: true, force: true });
    await mkdir(obsDir, { recursive: true });
    const sets = await this.observationSets();
    for (const s of sets)
      await writeFile(
        join(obsDir, `${s.id}.json`),
        JSON.stringify(s.body, null, 2) + "\n",
      );
    return { observationSets: sets.length };
  }
}
