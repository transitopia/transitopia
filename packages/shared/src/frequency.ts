// Transitopia's service frequency bands (apps/web/README.md#service-frequency): one definition for
// the route and stop cards' graphs and keys, the map's bus corridors and stop ticks, and the layers
// panel's key. A presentation choice, the same for every route in every region, not an operator's
// standard.

export interface FrequencyBand {
  id: "good" | "ok" | "poor" | "bad";
  name: string;
  /**
   * The worst wait in minutes (packages/transit-core/src/schedule/frequency.ts → `worstWait`), up to
   * and including this (the last band has none).
   */
  maxMinutes?: number;
  /** Colours per theme: blue → red, never green or amber (those mean other things on the site). */
  color: { light: string; dark: string };
}

export const FREQUENCY_BANDS: readonly FrequencyBand[] = [
  {
    id: "good",
    name: "Good",
    maxMinutes: 6,
    color: { light: "#1d5aa6", dark: "#5470e6" },
  },
  {
    id: "ok",
    name: "OK",
    maxMinutes: 12,
    color: { light: "#3f97e8", dark: "#2a9fd0" },
  },
  {
    id: "poor",
    name: "Poor",
    maxMinutes: 20,
    color: { light: "#ec6a80", dark: "#dc6488" },
  },
  { id: "bad", name: "Bad", color: { light: "#b0213a", dark: "#d4333f" } },
];

/**
 * The band (index into FREQUENCY_BANDS) for a worst wait of `minutes`, rounded to whole minutes as
 * the site shows it: re-timed SkyTrain waits are rarely whole minutes, and "up to 6 min" should
 * never be OK when 6 is Good.
 */
export function bandIndex(minutes: number): number {
  const shown = Math.round(minutes);
  const i = FREQUENCY_BANDS.findIndex(
    (b) => b.maxMinutes !== undefined && shown <= b.maxMinutes,
  );
  return i >= 0 ? i : FREQUENCY_BANDS.length - 1;
}

/** A band's range, short: "≤6m", …, ">20m". */
export function bandRange(i: number): string {
  const max = FREQUENCY_BANDS[i]?.maxMinutes;
  return max !== undefined ?
      `≤${max}m`
    : `>${FREQUENCY_BANDS[i - 1]?.maxMinutes ?? 0}m`;
}

/** A band's range in words, as a worst wait: "Wait up to 6 min", …, "Wait over 20 min". */
export function bandWait(i: number): string {
  const max = FREQUENCY_BANDS[i]?.maxMinutes;
  return max !== undefined ?
      `Wait up to ${max} min`
    : `Wait over ${FREQUENCY_BANDS[i - 1]?.maxMinutes ?? 0} min`;
}
