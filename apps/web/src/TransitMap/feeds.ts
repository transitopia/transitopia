// Every feed /transit can show, found in config/ (docs/DESIGN.md#feeds-operators-and-rail-networks),
// with its settings resolved from the defaults and its operator (packages/transit-core/src/config.ts)
// and the rail network it runs on, if any; checked as the transit chunk loads. Adding a feed is data
// only: the engine loads each one while its coverage is in view (packages/transit-map/README.md#feeds).

import {
  parseConfig,
  parseFeed,
  parseNetwork,
  parseOperator,
  resolveKinematics,
  resolveRt,
  type NetworkInfo,
} from "@transitopia/transit-core/config.ts";
import type { FeedConfig } from "@transitopia/transit-map/engine.ts";

type Files = Record<string, unknown>;
// Glob options are inline: Vite reads them statically.
// Keys are paths: …/config/<kind>/<id>/<file>.json.
const networkFiles: Files = import.meta.glob(
  "../../../../config/networks/*/{network,operations}.json",
  { eager: true, import: "default" },
);
const feedFiles: Files = import.meta.glob(
  "../../../../config/feeds/*/{feed,routes}.json",
  { eager: true, import: "default" },
);
const operatorFiles: Files = import.meta.glob(
  "../../../../config/operators/*/operator.json",
  { eager: true, import: "default" },
);
const defaults: Files = import.meta.glob(
  "../../../../config/defaults/{kinematics,rt}.json",
  { eager: true, import: "default" },
);

/** The file `<kind>/<id>/<name>.json` among `files`, if there is one. */
function file(files: Files, kind: string, id: string, name: string): unknown {
  const suffix = `/config/${kind}/${id}/${name}.json`;
  return Object.entries(files).find(([path]) => path.endsWith(suffix))?.[1];
}

function defaultsFile(name: string): unknown {
  const f = Object.entries(defaults).find(([path]) =>
    path.endsWith(`/config/defaults/${name}.json`),
  )?.[1];
  if (f === undefined) throw new Error(`config/defaults/${name}.json missing`);
  return f;
}

/** A feed's config, with its operator's and the defaults' settings and its rail network, if any. */
function feedConfig(feedId: string): FeedConfig {
  const feed = parseFeed(file(feedFiles, "feeds", feedId, "feed"));
  const routes = parseConfig(
    "routes",
    file(feedFiles, "feeds", feedId, "routes"),
  );
  const op = parseOperator(
    file(operatorFiles, "operators", feed.operator, "operator"),
  );
  const net = NETWORKS.find((n) => n.feeds.includes(feedId));
  return {
    feed,
    kinematics: resolveKinematics(
      defaultsFile("kinematics"),
      op,
      feed,
      routes.routes,
    ),
    rt: resolveRt(defaultsFile("rt"), op, feed),
    ...(net ?
      {
        rail: {
          network: net.id,
          operations: parseConfig(
            "operations",
            file(networkFiles, "networks", net.id, "operations"),
          ),
        },
      }
    : {}),
  };
}

/** Every rail network (config/networks/*). */
const NETWORKS: readonly NetworkInfo[] = Object.entries(networkFiles)
  .filter(([path]) => path.endsWith("/network.json"))
  .map(([, json]) => parseNetwork(json));

/** Every feed (config/feeds/*), by id, for the engine (TransitEngineOptions.feeds). */
export const FEEDS: readonly FeedConfig[] = [
  ...new Set(Object.keys(feedFiles).map((path) => path.split("/").at(-2)!)),
]
  .sort()
  .map(feedConfig);

/**
 * The rail network whose corrections /admin reviews: the server's live dispatcher and corrections
 * support one so far.
 */
export function railNetwork(): NetworkInfo {
  if (NETWORKS.length !== 1)
    throw new Error(`Expected one rail network, found ${NETWORKS.length}`);
  return NETWORKS[0]!;
}
