// Alert drafts (PLAN.md §4.10, M8.5): TransLink alerts for our rail lines → draft disruptions in
// data/disruptions/drafts/, which a person confirms with `npm run disruptions -- confirm <id>`. Every
// change to the alert set is appended to data/rt-history/alerts.ndjson.

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { draftFromAlert, type ServiceAlert } from '../../src/core/disruption/alerts.ts';
import type { DisruptionFile } from '../../src/core/disruption/types.ts';

export interface AlertDraftsOptions {
  disruptionsDir: string;
  historyDir: string;
  log: (msg: string) => void;
}

export class AlertDrafts {
  private lastSet = '';

  constructor(private opts: AlertDraftsOptions) {}

  get draftsDir(): string {
    return join(this.opts.disruptionsDir, 'drafts');
  }

  /** Record the current alerts and (re)write drafts for the ones we can model. */
  async update(alerts: ServiceAlert[], now = Date.now()): Promise<void> {
    const set = JSON.stringify(alerts);
    if (set === this.lastSet) return;
    this.lastSet = set;
    await mkdir(this.opts.historyDir, { recursive: true });
    await appendFile(join(this.opts.historyDir, 'alerts.ndjson'), JSON.stringify({ ts: now, alerts }) + '\n');
    await mkdir(this.draftsDir, { recursive: true });
    const unparsed: { id: string; lines: string[]; header: string; reason: string }[] = [];
    for (const a of alerts) {
      const d = draftFromAlert(a);
      if (!d.draft) {
        unparsed.push({ id: a.id, lines: a.lines, header: a.header, reason: d.unparsed ?? '' });
        continue;
      }
      // Confirmed already: the person's version wins.
      if (existsSync(join(this.opts.disruptionsDir, `${d.draft.id}.json`))) continue;
      const path = join(this.draftsDir, `${d.draft.id}.json`);
      const file: DisruptionFile = { $comment: `Draft from TransLink alert ${a.id}. Confirm with: npm run disruptions -- confirm ${d.draft.id} --keep "<platform stop that stays open>"`, disruptions: [d.draft] };
      const text = JSON.stringify(file, null, 2) + '\n';
      const old = await readFile(path, 'utf8').catch(() => '');
      if (old !== text) {
        await writeFile(path, text);
        this.opts.log(`draft disruption ${d.draft.id}: ${a.header}`);
      }
    }
    await writeFile(join(this.draftsDir, 'unparsed.json'), JSON.stringify(unparsed, null, 2) + '\n');
  }
}
