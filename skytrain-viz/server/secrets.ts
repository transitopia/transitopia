// Reads TRANSLINK_API_KEY from the environment or the repo's .secrets file (KEY=VALUE lines).
// The key is never logged or returned to clients.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../scripts/lib/paths.ts';

export function translinkApiKey(): string | undefined {
  if (process.env.TRANSLINK_API_KEY) return process.env.TRANSLINK_API_KEY.trim();
  try {
    const text = readFileSync(join(ROOT, '.secrets'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*TRANSLINK_API_KEY\s*=\s*(.+?)\s*$/.exec(line);
      if (m) return m[1]!.replace(/^["']|["']$/g, '');
    }
  } catch {
    // No .secrets file.
  }
  return undefined;
}
