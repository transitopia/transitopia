// Service frequency as the site shows it (apps/web/README.md#service-frequency). The bands and their
// colours are @transitopia/shared/frequency.ts, shared with the map; the colours reach CSS as the
// --band-* properties, set here per theme.

import {
  FREQUENCY_BANDS,
  bandIndex,
  bandRange,
} from "@transitopia/shared/frequency.ts";

export interface Band {
  id: string;
  name: string;
  /** CSS colour (a custom property, so it follows the theme). */
  color: string;
}

// Inject our frequency band color definitions into the document's CSS at import time.
// Done in this way so that we have a shared definition between TypeScript and CSS.
// Happens only in the browser (skip when tests import this in Node).
if (typeof document !== "undefined") {
  const style = document.createElement("style");
  style.dataset["source"] = "frequency-bands";
  style.textContent = (["light", "dark"] as const)
    .map(
      (theme) =>
        `${theme === "light" ? ":root" : ':root[data-theme="dark"]'}{${FREQUENCY_BANDS.map(
          (b) => `--band-${b.id}:${b.color[theme]};`,
        ).join("")}}`,
    )
    .join("\n");
  document.head.append(style);
}

/** The band for a worst wait of `minutes` (packages/transit-core/src/schedule/frequency.ts). */
export function bandOf(minutes: number): Band {
  const b = FREQUENCY_BANDS[bandIndex(minutes)]!;
  return { id: b.id, name: b.name, color: `var(--band-${b.id})` };
}

/** Every band with its range, for keys ("Good ≤6m", …, "Bad >20m"). */
export function bandKey(): (Band & { range: string })[] {
  return FREQUENCY_BANDS.map((b, i) => ({
    id: b.id,
    name: b.name,
    color: `var(--band-${b.id})`,
    range: bandRange(i),
  }));
}

/** "every 8m", or "every ~5m" for a combined estimate. */
export function everyText(minutes: number, approx = false): string {
  return `every ${approx ? "~" : ""}${Math.max(1, Math.round(minutes))}m`;
}

/** "up to 15m": a worst wait. */
export function upToText(minutes: number): string {
  return `up to ${Math.max(1, Math.round(minutes))}m`;
}
