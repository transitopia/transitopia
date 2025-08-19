export const CyclingComfort = {
  /** A fully separated bike track that's off-street or has a physical barrier separating it from traffic */
  MOST: 4,
  /** e.g. shared lane on a quiet neighborhood street */
  HIGH: 3,
  /** e.g. a painted bike lane, but not separated from traffic */
  LOW: 2,
  /** e.g. a shared use lane on a busy street */
  LEAST: 1,
} as const;
type CyclingComfort = (typeof CyclingComfort)[keyof typeof CyclingComfort];

/**
 * Data included for cycling tracks/lanes in the Transitopia Cycling layer of our map.
 *
 * Can also be loaded directly from the OpenStreetMap API by parsing the Way's tag data
 * with `deriveCyclingTags()`.
 */
export interface MapCyclingWay {
  type: "cycling/way";
  osm_way_id?: number;
  name?: string;
  construction?: boolean;
  shared_with_pedestrians: boolean;
  shared_with_vehicles: boolean;
  dooring_risk?: boolean;
  /** Surface, i.e. paved or not. */
  surface?: string;
  /** A cycle *track* is separate from the road (off-road). A lane is part of a road. */
  class: "lane" | "track";
  comfort: CyclingComfort;
  oneway: 0 | 1 | -1;
  /** If there's a cycle lane on only one side of the road, which side? */
  side?: "right" | "left";

  // Mostly for things under construction:
  website?: string;
  opening_date?: string;
}
