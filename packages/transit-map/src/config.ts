// The region config the engine runs with (packages/transit-core/src/config.ts). The host passes it
// in (TransitEngineOptions.config), checked with parseConfig: the engine knows no region of its own.

import type { Config } from "@transitopia/transit-core/config.ts";

export interface RegionConfig {
  kinematics: Config<"kinematics">;
  operations: Config<"operations">;
  rt: Config<"rt">;
  seabus: Config<"seabus">;
}
