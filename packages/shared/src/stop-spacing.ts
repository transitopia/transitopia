// Transitopia's stop spacing categories (apps/web/README.md#stop-spacing): one definition for the
// route cards' chip, the plan's route figures and the layers panel's Fast Bus switch. A presentation
// choice, the same for every route in every region, from published guidance where there is some:
//   TransLink, Transit Service Guidelines (2018), U.2 Stop Spacing: Standard and Basic routes
//     250–400 m, Frequent 300–800 m, Rapid 800–1,500 m, measured as route length ÷ (stops − 1).
//     https://www.translink.ca/-/media/translink/documents/plans-and-projects/managing-the-transit-network/transit-oriented-communities/transit-services-guidelines-public-summary.pdf
//   BC Transit, On-Street Infrastructure Design Guide (2024): local 250–300 m, Frequent 300–500 m,
//     Rapid 800–2,000 m.
//     https://www.bctransit.com/wp-content/uploads/2024/04/BCT-On-street-Infrastructure-Design-Guide-2024.pdf

export interface StopSpacingTier {
  id: "every-block" | "local" | "limited" | "express";
  name: string;
  /** Average spacing (m, transit-core schedule/stops.ts → `RouteStops.spacing`) from which a route is in this tier. */
  minMetres: number;
  /** A fast route: it skips enough stops to be on the layers panel's Fast Bus switch (issue #211). */
  fast: boolean;
}

export const STOP_SPACING_TIERS: readonly StopSpacingTier[] = [
  // Below TransLink's 250 m minimum for any route: Vancouver's old streetcar routes (the 20, 8, 29).
  {
    id: "every-block",
    name: "Every block",
    minMetres: 0,
    fast: false,
  },
  // TransLink's Standard 250–400 m and the lower half of its Frequent 300–800 m.
  {
    id: "local",
    name: "Local",
    minMetres: 250,
    fast: false,
  },
  // The upper half of Frequent and TransLink's Rapid 800–1,500 m (the 99 B-Line, RapidBus, Blink).
  // 600 m is a guess: it puts Victoria's 95 Blink (about 740 m) with the B-Line rather than with
  // local routes.
  {
    id: "limited",
    name: "Limited stops",
    minMetres: 600,
    fast: true,
  },
  // Beyond Rapid: highway runs between clusters of stops (the 257, 620, Kelowna's 97).
  {
    id: "express",
    name: "Express",
    minMetres: 1500,
    fast: true,
  },
];

/** The tier (index into STOP_SPACING_TIERS) for an average spacing of `metres`. */
export function spacingTierIndex(metres: number): number {
  let i = 0;
  while (
    i + 1 < STOP_SPACING_TIERS.length
    && metres >= STOP_SPACING_TIERS[i + 1]!.minMetres
  )
    i++;
  return i;
}

export function spacingTier(metres: number): StopSpacingTier {
  return STOP_SPACING_TIERS[spacingTierIndex(metres)]!;
}
