// The settings the server uses, checked when it starts (packages/transit-core/src/config.ts): its
// rail region's (live dispatch, recording, and its port), real-time settings resolved
// from config/defaults/rt.json, TransLink's overrides, its feed's and Metro Vancouver's. Each feed's polling is
// in its feed.json (readFeeds in main.ts).

import {
  parseConfig,
  parseFeed,
  parseOperator,
  parseRegionRt,
  resolveRt,
} from "@transitopia/transit-core/config.ts";
import defaultRt from "@transitopia/config/defaults/rt.json" with { type: "json" };
import translink from "@transitopia/config/operators/translink/operator.json" with { type: "json" };
import translinkFeed from "@transitopia/config/feeds/translink/feed.json" with { type: "json" };
import recordingJson from "@transitopia/config/regions/metro-vancouver/recording.json" with { type: "json" };
import rtJson from "@transitopia/config/regions/metro-vancouver/rt.json" with { type: "json" };

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined)
    throw new Error(
      `config/regions/metro-vancouver/rt.json needs ${name} (the server reads it)`,
    );
  return value;
}

const rt = resolveRt(
  defaultRt,
  parseOperator(translink),
  parseFeed(translinkFeed),
  parseRegionRt(rtJson),
);
export const recordingConfig = parseConfig("recording", recordingJson);
export const rtConfig = {
  ...rt,
  dispatchCheckS: required(rt.dispatchCheckS, "dispatchCheckS"),
  dispatchWindowDays: required(rt.dispatchWindowDays, "dispatchWindowDays"),
  serverPort: required(rt.serverPort, "serverPort"),
};
