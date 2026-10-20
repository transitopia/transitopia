// Publish var/public/data to object storage the way the server's data job does (compressed, with
// its cache headers): for the manual fallback workflow, .github/workflows/build_transit_data.yml.
//
//   npm run publish:data -- <rclone remote, e.g. r2:transitopia-data>

import { publishData } from "../jobs/publish.ts";

const remote = process.argv[2];
if (!remote) {
  console.error("Usage: npm run publish:data -- <rclone remote>");
  process.exit(1);
}
await publishData(remote, undefined, (m) => console.log(m));
console.log(`published transit data to ${remote}`);
