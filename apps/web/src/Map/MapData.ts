import type {
  BikeParkingProperties,
  CyclingWayProperties,
} from "@transitopia/cycling-core/tiles.ts";

/** A cycling track or lane from the cycling tiles (packages/cycling-core/README.md#tiles), as selected. */
export type MapCyclingElement = CyclingWayProperties & {
  id: string;
  type: "cycling_way";
};

/** Bike parking from the cycling tiles, as selected. */
export type MapParkingElement = BikeParkingProperties & {
  id: string;
  type: "bicycle_parking";
};
