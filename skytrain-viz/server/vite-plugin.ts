import type { Plugin } from 'vite';

/** Placeholder until the RT service lands (PLAN.md §4.6). */
export function rtServicePlugin(): Plugin {
  return { name: 'skytrain-rt-service' };
}
