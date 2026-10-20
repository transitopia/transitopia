// Publish var/public/data to object storage the way the server's data job does (compressed, with
// its cache headers): for the manual fallback workflow, .github/workflows/build_transit_data.yml.
//
//   npm run publish:data -- <rclone remote, e.g. r2:transitopia-data>

import { availableParallelism } from "node:os";
import { publishData } from "../jobs/publish.ts";

const remote = process.argv[2];
if (!remote) {
  console.error("Usage: npm run publish:data -- <rclone remote>");
  process.exit(1);
}
// Nothing else runs here, so compress on every core.
await publishData(remote, {
  log: (m) => console.log(m),
  concurrency: availableParallelism(),
});
console.log(`published transit data to ${remote}`);
