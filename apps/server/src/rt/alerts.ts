// Alert drafts (packages/transit-core/DESIGN.md#disruptions-and-alerts): TransLink alerts for our rail lines → draft
// disruptions, which a person confirms: in the database's review queue (/admin) when there is one,
// else in regions/metro-vancouver/disruptions/drafts/ for `npm run disruptions -- confirm <id>`.
// Every change to the alert set is appended to var/rt-history/alerts.ndjson.

import { appendFile, mkdir, open, readFile, writeFile } from "node:fs/promises";
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

  get historyPath(): string {
    return join(this.opts.historyDir, "alerts.ndjson");
  }

  /**
   * The last recorded alert set, for the time between a restart and the first alerts poll (up to
   * the poll interval, since the ledger spaces polls across restarts). Sets `unparsed` from it.
   */
  async restore(): Promise<ServiceAlert[]> {
    const last = await lastLine(this.historyPath);
    if (!last) return [];
    const { alerts } = JSON.parse(last) as { alerts: ServiceAlert[] };
    this.lastSet = JSON.stringify(alerts);
    this.unparsed = alerts.flatMap((a) => {
      const reason = draftFromAlert(a).unparsed;
      return reason === undefined ? [] : [unparsedAlert(a, reason)];
    });
    return alerts;
  }

  /** Record the current alerts and (re)write drafts for the ones we can model. */
  async update(alerts: ServiceAlert[], now = Date.now()): Promise<void> {
    const set = JSON.stringify(alerts);
    if (set === this.lastSet) return;
    this.lastSet = set;
    await mkdir(this.opts.historyDir, { recursive: true });
    await appendFile(
      this.historyPath,
      JSON.stringify({ ts: now, alerts }) + "\n",
    );
    const { repo } = this.opts;
    if (!repo) await mkdir(this.draftsDir, { recursive: true });
    const unparsed: UnparsedAlert[] = [];
    for (const a of alerts) {
      const d = draftFromAlert(a);
      if (!d.draft) {
        unparsed.push(unparsedAlert(a, d.unparsed ?? ""));
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

const unparsedAlert = (a: ServiceAlert, reason: string): UnparsedAlert => ({
  id: a.id,
  lines: a.lines,
  header: a.header,
  reason,
});

/** The last complete line of a file, read from its end (alerts.ndjson grows by ~0.5 MB a day). */
async function lastLine(path: string): Promise<string | undefined> {
  const f = await open(path, "r").catch(() => undefined);
  if (!f) return undefined;
  try {
    const { size } = await f.stat();
    for (let n = 256 * 1024; ; n *= 4) {
      const start = Math.max(0, size - n);
      const buf = Buffer.alloc(size - start);
      await f.read(buf, 0, buf.length, start);
      // Skip a partly written last line (the process stopped mid-write) and, unless this is the
      // whole file, the cut-off first one.
      const lines = buf
        .toString("utf8")
        .split("\n")
        .slice(start ? 1 : 0);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          JSON.parse(lines[i]!);
          return lines[i];
        } catch {
          // Empty or partial: try the one before.
        }
      }
      if (!start) return undefined;
    }
  } finally {
    await f.close();
  }
}
