import { COMFORT, type Comfort } from "@transitopia/cycling-core/classify.ts";

/**
 * What the site calls each comfort level (packages/cycling-core/src/classify.ts), most comfortable
 * first: the layers panel's switches and the route card's breakdown.
 */
export const COMFORT_NAMES: Record<
  Comfort,
  { title: string; description: string }
> = {
  [COMFORT.most]: {
    title: "Protected lanes & paths",
    description: "Separated from traffic",
  },
  [COMFORT.high]: {
    title: "Shared paths",
    description: "Traffic-calmed streets, or paths shared with pedestrians",
  },
  [COMFORT.low]: {
    title: "Painted bike lanes",
    description: "Next to traffic",
  },
  [COMFORT.least]: {
    title: "Shared lanes",
    description: "On busy streets, or painted lanes next to parked cars",
  },
};
