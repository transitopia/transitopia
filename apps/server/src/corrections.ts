// Corrections: observations and disruptions (docs/DESIGN.md#corrections-and-previews), in the
// observation_sets and disruptions tables with a review state (draft → previewing → confirmed |
// discarded). The live dispatcher reads the confirmed ones through `Corrections`; `importFiles`
// brings in the committed files (TransLink's observations in config/feeds/translink/observations/,
// the SkyTrain's disruptions in config/networks/skytrain/disruptions/), and `export` writes the
// confirmed ones back to that format (for tests, reproducible bug reports and the static build).

import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  correctionPaths,
  readJson,
  type RailNetwork,
} from "@transitopia/data/paths.ts";
import { datesOf, loadDisruptions } from "@transitopia/data/disruptions.ts";
import type { Db } from "@transitopia/db/connect.ts";
import type {
  DisruptionRow as ApiDisruptionRow,
  ObservationRow,
  ReviewState,
} from "@transitopia/shared/admin-api.ts";
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

/** A row as the admin API sends it, with the columns it leaves out. */
type Stored<T> = T & { created_at: Date };
export type ObservationSetRow = Stored<ObservationRow> & { feed_id: string };
export type DisruptionRow = Stored<ApiDisruptionRow> & { network_id: string };

/**
 * Corrections in the database: what the dispatcher applies, and the admin's review queue. A rail
 * network's: its disruptions, and its feed's observations.
 */
export class CorrectionsRepo implements Corrections {
  readonly db: Db;
  readonly net: RailNetwork;

  constructor(db: Db, net: RailNetwork) {
    this.db = db;
    this.net = net;
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
      .where("feed_id", "=", this.net.feed);
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
      .where("network_id", "=", this.net.network);
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
        feed_id: this.net.feed,
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
        network_id: this.net.network,
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
    const now = new Date();
    const set = {
      state,
      updated_at: now,
      ...(state === "confirmed" || state === "discarded" ?
        { reviewed_by: by, reviewed_at: now }
      : {}),
    };
    const r =
      kind === "observations" ?
        await this.db
          .updateTable("observation_sets")
          .set(set)
          .where("id", "=", id)
          .where("feed_id", "=", this.net.feed)
          .executeTakeFirst()
      : await this.db
          .updateTable("disruptions")
          .set(set)
          .where("id", "=", id)
          .where("network_id", "=", this.net.network)
          .executeTakeFirst();
    return Number(r.numUpdatedRows) > 0;
  }

  /**
   * Import correction files from a directory laid out like config/ (correctionPaths; default: the
   * committed files). Idempotent: existing ids are left as they are.
   */
  async importFiles(
    root?: string,
  ): Promise<{ observationSets: number; disruptions: number }> {
    const { observations: observationsDir, disruptions: disruptionsDir } =
      correctionPaths(this.net, root);
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
   * Write the confirmed corrections as files under `root`, laid out like config/ (correctionPaths):
   * feeds/<feed>/observations/<id>.json and networks/<network>/disruptions/<id>.json (the formats in
   * config/feeds/translink/observations/README.md and config/networks/skytrain/disruptions/README.md).
   * The directories are replaced, so they hold exactly what's confirmed.
   */
  async exportFiles(
    root: string,
  ): Promise<{ observationSets: number; disruptions: number }> {
    const { observations: obsDir, disruptions: disDir } = correctionPaths(
      this.net,
      root,
    );
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
