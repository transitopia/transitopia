// The region config the engine uses, checked when it loads (packages/transit-core/src/config.ts).

import { parseConfig } from "@transitopia/transit-core/config.ts";
import kinematicsJson from "@transitopia/region-metro-vancouver/config/kinematics.json";
import operationsJson from "@transitopia/region-metro-vancouver/config/operations.json";
import rtJson from "@transitopia/region-metro-vancouver/config/rt.json";
import seabusJson from "@transitopia/region-metro-vancouver/config/seabus.json";

export const kinematicsConfig = parseConfig("kinematics", kinematicsJson);
export const operationsConfig = parseConfig("operations", operationsJson);
export const rtConfig = parseConfig("rt", rtJson);
export const seabusConfig = parseConfig("seabus", seabusJson);
