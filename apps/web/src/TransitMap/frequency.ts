// Service frequency as the site shows it (apps/web/README.md#service-frequency), with colours per
// theme from the --band-* properties.

export interface Band {
  id: string;
  name: string;
  /** CSS colour (a custom property, so it follows the theme). */
  color: string;
}

/**
 * Transitopia's frequency bands, the same for every route in every region: average minutes between
 * departures in an hour, up to and including maxMinutes (the last band has none). A presentation
 * choice, not an operator's standard.
 */
const BANDS: { id: string; name: string; maxMinutes?: number }[] = [
  { id: "good", name: "Good", maxMinutes: 6 },
  { id: "ok", name: "OK", maxMinutes: 12 },
  { id: "poor", name: "Poor", maxMinutes: 20 },
  { id: "bad", name: "Bad" },
];

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
