// A feed's config, as the engine runs it (packages/transit-core/src/config.ts). The host passes one
// per feed (TransitEngineOptions.feeds), checked with parseConfig, parseFeed and parseNetwork: the
// engine knows no feed of its own.

import type { Config, FeedInfo } from "@transitopia/transit-core/config.ts";

export interface FeedConfig {
  feed: FeedInfo;
  /** Its vehicles' settings, resolved from the defaults, its operator, the feed and its routes. */
  kinematics: Config<"kinematics">;
  rt: Config<"rt">;
  /**
   * Track-level rail, where the feed runs on a rail network (config/networks/<id>/network.json →
   * feeds): the network's id and its run inference settings. Then the engine loads the network's
   * tracks and dispatch patches and the feed's movements and observations. Absent: timetables and
   * real time only.
   */
  rail?: { network: string; operations: Config<"operations"> } | undefined;
}
