// The settings the server uses, checked when it starts (packages/transit-core/src/config.ts): its own
// (config/server/: port, live dispatch, recording), and the real-time defaults (config/defaults/rt.json)
// for the live endpoint's edge-cache time. Each feed's polling is in its feed.json (readFeeds in main.ts).

import { parseConfig } from "@transitopia/transit-core/config.ts";
import defaultRt from "@transitopia/config/defaults/rt.json" with { type: "json" };
import serverJson from "@transitopia/config/server/server.json" with { type: "json" };
import recordingJson from "@transitopia/config/server/recording.json" with { type: "json" };

export const serverConfig = parseConfig("server", serverJson);
export const recordingConfig = parseConfig("recording", recordingJson);
export const rtDefaults = parseConfig("rt", defaultRt);
