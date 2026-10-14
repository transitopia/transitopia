// The region config the server uses, checked when it starts (packages/transit-core/src/config.ts):
// its rail region's (SeaBus AIS, live dispatch, recording and its port). Each feed's polling is in
// feeds/<feed>/feed.json (readFeeds in main.ts).

import { parseConfig } from "@transitopia/transit-core/config.ts";
import recordingJson from "@transitopia/region-metro-vancouver/config/recording.json" with { type: "json" };
import rtJson from "@transitopia/region-metro-vancouver/config/rt.json" with { type: "json" };
import seabusJson from "@transitopia/region-metro-vancouver/config/seabus.json" with { type: "json" };

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined)
    throw new Error(
      `regions/metro-vancouver/config/rt.json needs ${name} (the server reads it)`,
    );
  return value;
}

const rt = parseConfig("rt", rtJson);
export const recordingConfig = parseConfig("recording", recordingJson);
export const rtConfig = {
  ...rt,
  dispatchCheckS: required(rt.dispatchCheckS, "dispatchCheckS"),
  dispatchWindowDays: required(rt.dispatchWindowDays, "dispatchWindowDays"),
  serverPort: required(rt.serverPort, "serverPort"),
};
export const seabusConfig = parseConfig("seabus", seabusJson);
