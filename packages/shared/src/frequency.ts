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
  /** A frequent route's band: its weekday figure in it puts it on the layers panel's Frequent Bus switch (issue #211). */
  frequent: boolean;
  /**
   * Colours per theme: blue, then a dusty red for Poor (muted so it doesn't outshine OK), fading to
   * a muted rose for Bad, never green or amber (those mean other things on the site).
   */
  color: { light: string; dark: string };
}

export const FREQUENCY_BANDS: readonly FrequencyBand[] = [
  {
    id: "good",
    frequent: true,
    name: "Good",
    maxMinutes: 6,
    color: { light: "#1d5aa6", dark: "#5470e6" },
  },
  {
    id: "ok",
    frequent: true,
    name: "OK",
    maxMinutes: 12,
    color: { light: "#3f97e8", dark: "#2a9fd0" },
  },
  {
    id: "poor",
    frequent: false,
    name: "Poor",
    maxMinutes: 20,
    color: { light: "#bc6b77", dark: "#c07282" },
  },
  // Bad is the quietest band, not the loudest: a muted rose, so "a bus runs here" doesn't outshine
  // the streets that have good service (the map also draws it faded and thin).
  {
    id: "bad",
    frequent: false,
    name: "Bad",
    color: { light: "#c9a3ab", dark: "#7a5a62" },
  },
];

/**
 * Where routes run but none in the window shown: a dotted grey line on the map, so a route the
 * site mentions is never missing from it.
 */
export const NO_SERVICE = {
  name: "No service",
  color: { light: "#9aa1a9", dark: "#5f666e" },
} as const;

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

/** Whether a worst wait of `minutes` is in a frequent band (`FrequencyBand.frequent`). */
export function isFrequent(minutes: number): boolean {
  return FREQUENCY_BANDS[bandIndex(minutes)]!.frequent;
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
