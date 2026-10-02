// Alert drafts (packages/transit-core/DESIGN.md#disruptions-and-alerts): TransLink alerts for our rail lines → draft
// disruptions, which a person confirms: in the database's review queue (/admin) when there is one,
// else in regions/metro-vancouver/disruptions/drafts/ for `npm run disruptions -- confirm <id>`.
// Every change to the alert set is appended to var/rt-history/alerts.ndjson.

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  draftFromAlert,
  type ServiceAlert,
} from "@transitopia/transit-core/disruption/alerts.ts";
import type { DisruptionFile } from "@transitopia/transit-core/disruption/types.ts";
import type { CorrectionsRepo } from "../corrections.ts";

export interface AlertDraftsOptions {
  disruptionsDir: string;
  historyDir: string;
  /** Draft into the database instead of files. */
  repo?: CorrectionsRepo | undefined;
  log: (msg: string) => void;
}

export interface UnparsedAlert {
  id: string;
  lines: string[];
  header: string;
  reason: string;
}

export class AlertDrafts {
  private lastSet = "";
  /** Current alerts we couldn't draft a disruption from (someone may write one by hand). */
  unparsed: UnparsedAlert[] = [];

  private opts: AlertDraftsOptions;

  constructor(opts: AlertDraftsOptions) {
    this.opts = opts;
  }

  get draftsDir(): string {
    return join(this.opts.disruptionsDir, "drafts");
  }

  /** Record the current alerts and (re)write drafts for the ones we can model. */
  async update(alerts: ServiceAlert[], now = Date.now()): Promise<void> {
    const set = JSON.stringify(alerts);
    if (set === this.lastSet) return;
    this.lastSet = set;
    await mkdir(this.opts.historyDir, { recursive: true });
    await appendFile(
      join(this.opts.historyDir, "alerts.ndjson"),
      JSON.stringify({ ts: now, alerts }) + "\n",
    );
    const { repo } = this.opts;
    if (!repo) await mkdir(this.draftsDir, { recursive: true });
    const unparsed: UnparsedAlert[] = [];
    for (const a of alerts) {
      const d = draftFromAlert(a);
      if (!d.draft) {
        unparsed.push({
          id: a.id,
          lines: a.lines,
          header: a.header,
          reason: d.unparsed ?? "",
        });
        continue;
      }
      if (repo) {
        if (await repo.saveAlertDraft(d.draft))
          this.opts.log(`draft disruption ${d.draft.id}: ${a.header}`);
        continue;
      }
      // Confirmed already: the person's version wins.
      if (existsSync(join(this.opts.disruptionsDir, `${d.draft.id}.json`)))
        continue;
      const path = join(this.draftsDir, `${d.draft.id}.json`);
      const file: DisruptionFile = {
        $comment: `Draft from TransLink alert ${a.id}. Confirm with: npm run disruptions -- confirm ${d.draft.id} --keep "<platform stop that stays open>"`,
        disruptions: [d.draft],
      };
      const text = JSON.stringify(file, null, 2) + "\n";
      const old = await readFile(path, "utf8").catch(() => "");
      if (old !== text) {
        await writeFile(path, text);
        this.opts.log(`draft disruption ${d.draft.id}: ${a.header}`);
      }
    }
    this.unparsed = unparsed;
    if (repo) return;
    await writeFile(
      join(this.draftsDir, "unparsed.json"),
      JSON.stringify(unparsed, null, 2) + "\n",
    );
  }
}
