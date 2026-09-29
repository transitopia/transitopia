// Reads API keys from the environment or the repo's .secrets file (KEY=VALUE lines).
// Keys are never logged or returned to clients.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '@transitopia/pipelines/lib/paths.ts';

export function secret(name: string): string | undefined {
  if (process.env[name]) return process.env[name]!.trim();
  try {
    const text = readFileSync(join(ROOT, '.secrets'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const eq = line.indexOf('=');
      if (eq < 0 || line.slice(0, eq).trim() !== name) continue;
      return line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    }
  } catch {
    // No .secrets file.
  }
  return undefined;
}

export const translinkApiKey = (): string | undefined => secret('TRANSLINK_API_KEY');
export const aisstreamApiKey = (): string | undefined => secret('AISSTREAM_API_KEY');
