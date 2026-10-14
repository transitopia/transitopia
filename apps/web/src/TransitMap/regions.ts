// Metro Vancouver's config for the transit engine, checked as the transit chunk loads
// (packages/transit-core/src/config.ts).

import { parseConfig } from "@transitopia/transit-core/config.ts";
import type { RegionConfig } from "@transitopia/transit-map/engine.ts";
import kinematics from "@transitopia/region-metro-vancouver/config/kinematics.json";
import operations from "@transitopia/region-metro-vancouver/config/operations.json";
import rt from "@transitopia/region-metro-vancouver/config/rt.json";
import seabus from "@transitopia/region-metro-vancouver/config/seabus.json";

export const regionConfig: RegionConfig = {
  kinematics: parseConfig("kinematics", kinematics),
  operations: parseConfig("operations", operations),
  rt: parseConfig("rt", rt),
  seabus: parseConfig("seabus", seabus),
};
