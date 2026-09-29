// Standalone RT service (proxy + cache + recorder) without Vite: leave it running to collect bus
// history, or point a static build at it.
//
//   npm run server             # http://localhost:8787/rt/live

import { createServer } from "node:http";
import rtConfig from "@transitopia/region-metro-vancouver/config/rt.json" with { type: "json" };
import { RtService } from "./rt/service.ts";
import { serveRt } from "./http.ts";
import region from "@transitopia/region-metro-vancouver/region.json" with { type: "json" };
import { checkTimezoneData } from "@transitopia/transit-core/time.ts";

// Every local time (service days, recordings, dispatch dates) comes from the runtime's time zone
// data, so refuse to start on an outdated copy rather than record and dispatch against wrong times.
const tzProblems = checkTimezoneData(region.timezoneChecks, region.timezone);
if (tzProblems.length) {
  console.error(
    [
      `[rt] Outdated time zone data (tzdata ${process.versions.tz ?? "unknown"} in this Node.js):`,
      ...tzProblems.map((p) => `  - ${p}`),
      "Update Node.js. Builds using the system's ICU (e.g. Homebrew's node) take their data from",
      "icu4c instead: use an official Node.js build, or point ICU_TIMEZONE_FILES_DIR at current data",
      "(https://github.com/unicode-org/icu-data/tree/main/tzdata/icunew).",
    ].join("\n"),
  );
  process.exit(1);
}

const port = Number(process.env.PORT ?? rtConfig.serverPort);
const service = new RtService();
const server = createServer((req, res) => void serveRt(service, req, res));
server.listen(port, () => {
  console.log(`[rt] Listening on http://localhost:${port}/rt/live`);
  void service.start(port);
});

const shutdown = () => {
  service.stop();
  server.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
