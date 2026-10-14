// The region config the server uses, checked when it starts (packages/transit-core/src/config.ts).

import { parseConfig } from "@transitopia/transit-core/config.ts";
import recordingJson from "@transitopia/region-metro-vancouver/config/recording.json" with { type: "json" };
import rtJson from "@transitopia/region-metro-vancouver/config/rt.json" with { type: "json" };
import seabusJson from "@transitopia/region-metro-vancouver/config/seabus.json" with { type: "json" };

export const recordingConfig = parseConfig("recording", recordingJson);
export const rtConfig = parseConfig("rt", rtJson);
export const seabusConfig = parseConfig("seabus", seabusJson);
