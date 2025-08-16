/**
 * Data included for cycling tracks/lanes in the Transitopia Cycling layer of our map.
 */
export interface MapCyclingElement {
  id: string;
  type: "cycling_way";
  name?: string;
  construction?: boolean;
  shared_with_pedestrians: boolean;
  shared_with_vehicles: boolean;
  dooring_risk?: boolean;
  surface?: string;
  class: "lane" | "track";
  comfort: 4 | 3 | 2 | 1;
  oneway: 0 | 1 | -1;

  // Mostly for things under construction:
  website?: string;
  opening_date?: string;
}

export interface MapParkingElement {
  id: string;
  type: "bicycle_parking";
  name?: string;
  osmNodeId?: string;
  osmWayId?: string;
}
