// The region config the engine runs with (packages/transit-core/src/config.ts). The host passes it
// in (TransitEngineOptions.config), checked with parseConfig and parseFeed: the engine knows no
// region of its own.

import type { Config, FeedInfo } from "@transitopia/transit-core/config.ts";

export interface RegionConfig {
  kinematics: Config<"kinematics">;
  rt: Config<"rt">;
  /**
   * The feed the region shows (region.json → feeds). A region can list several, but the engine
   * draws one per region for now (docs/DESIGN.md#regions-and-feeds).
   */
  feed: FeedInfo;
  /**
   * Track-level rail (run inference settings), in a region that has it: then the engine loads the
   * region's tracks, movements, dispatch patches and observations. Absent: timetables and real time only.
   */
  operations?: Config<"operations"> | undefined;
}
