// osmium-tool (https://osmcode.org/osmium-tool/), for reading OSM extracts (.osm.pbf): `OSMIUM` names
// the binary when it isn't on the PATH.

import { run } from "./exec.ts";

/** Run osmium with these arguments; its output. */
export async function osmium(
  args: string[],
  log?: (line: string) => void,
): Promise<string> {
  const cmd = process.env.OSMIUM || "osmium";
  return run(cmd, args, log ? { log } : {}).catch(
    (e: NodeJS.ErrnoException) => {
      throw e.code === "ENOENT" ?
          new Error(
            `${cmd} not found: install osmium-tool (brew install osmium-tool, apt install osmium-tool), or set OSMIUM`,
          )
        : e;
    },
  );
}

/** When an extract's data is from (its header's replication timestamp), as an ISO date-time. */
export async function extractTimestamp(pbf: string): Promise<string> {
  for (const key of [
    "header.option.osmosis_replication_timestamp",
    "header.option.timestamp",
  ]) {
    const v = (await osmium(["fileinfo", "-g", key, pbf])).trim();
    if (v) return v;
  }
  throw new Error(`${pbf} has no timestamp in its header`);
}
