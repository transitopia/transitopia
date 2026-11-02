// Named views of /transit (docs/DESIGN.md#feeds-operators-and-rail-networks): where it opens without
// a map position (the first), and the "Go to …" box shown where no feed is in view. Only for the UI:
// what the map shows comes from the feeds in view (packages/transit-map/README.md#feeds).

export interface TransitView {
  name: string;
  /** What the view fits on screen, [west, south, east, north]. */
  bounds: [number, number, number, number];
}

export const VIEWS: readonly TransitView[] = [
  // The SkyTrain network, UBC to King George.
  { name: "Metro Vancouver", bounds: [-123.2, 49.17, -122.79, 49.32] },
  // The 97, West Kelowna to UBC Okanagan.
  { name: "Central Okanagan", bounds: [-119.64, 49.82, -119.38, 49.95] },
  // Abbotsford and Mission to Chilliwack.
  { name: "Fraser Valley", bounds: [-122.4, 49.0, -121.9, 49.2] },
  // Langford to Swartz Bay and UVic.
  { name: "Greater Victoria", bounds: [-123.52, 48.41, -123.3, 48.69] },
];

/** [[west, south], [east, north]] for MapLibre. */
export function lngLatBounds(
  b: readonly [number, number, number, number],
): [[number, number], [number, number]] {
  return [
    [b[0], b[1]],
    [b[2], b[3]],
  ];
}
