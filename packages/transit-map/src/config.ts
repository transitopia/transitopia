// The region config the engine runs with (packages/transit-core/src/config.ts). The host passes it
// in (TransitEngineOptions.config), checked with parseConfig and parseFeed: the engine knows no
// region of its own.

import type { Config, FeedInfo } from "@transitopia/transit-core/config.ts";

export interface RegionConfig {
  kinematics: Config<"kinematics">;
  rt: Config<"rt">;
  /**
   * The feed the region shows (region.json → feeds). A region can list several, but the engine
   * draws one per region for now (docs/DESIGN.md#feeds-operators-and-rail-networks).
   */
  feed: FeedInfo;
  /**
   * Track-level rail, where the feed runs on a rail network (config/networks/<id>/network.json →
   * feeds): the network's id and its run inference settings. Then the engine loads the network's
   * tracks and dispatch patches and the feed's movements and observations. Absent: timetables and
   * real time only.
   */
  rail?: { network: string; operations: Config<"operations"> } | undefined;
}
