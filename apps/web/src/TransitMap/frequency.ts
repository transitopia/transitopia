import config from "@transitopia/region-metro-vancouver/config/frequency.json";

// Service frequency as the site shows it (apps/web/README.md#service-frequency): bands from
// regions/metro-vancouver/config/frequency.json, colours per theme from the --band-* properties.

export interface Band {
  id: string;
  name: string;
  /** CSS colour (a custom property, so it follows the theme). */
  color: string;
}

const BANDS = config.bands;

/** The band for an average of `minutes` between departures. */
export function bandOf(minutes: number): Band {
  const b =
    BANDS.find((x) => x.maxMinutes !== undefined && minutes <= x.maxMinutes)
    ?? BANDS[BANDS.length - 1]!;
  return { id: b.id, name: b.name, color: `var(--band-${b.id})` };
}

/** Every band with its range, for keys ("Good ≤6m", …, "Bad >20m"). */
export function bandKey(): (Band & { range: string })[] {
  return BANDS.map((b, i) => ({
    ...bandOf(b.maxMinutes ?? Infinity),
    range:
      b.maxMinutes !== undefined ?
        `≤${b.maxMinutes}m`
      : `>${BANDS[i - 1]?.maxMinutes ?? 0}m`,
  }));
}

/** "every 8m", or "every ~5m" for a combined estimate. */
export function everyText(minutes: number, approx = false): string {
  return `every ${approx ? "~" : ""}${Math.max(1, Math.round(minutes))}m`;
}
