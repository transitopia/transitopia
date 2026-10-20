// Published feature data (docs/DESIGN.md#published-features): the registry's public export
// (data/features/export/<YYYYMMDD>.ndjson.gz) and each feed version's places file
// (data/feeds/<feed>/<version>/places.<n>.json), written from a registry in its export form, which
// is what the server reads from its database and what `npm run features -- pull` downloads.

import { decodeCore } from "@transitopia/transit-core/plan/published.ts";
import { readPlanCore } from "./plans.ts";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  formatKey,
  nameSuffix,
  parseKey,
  type ExportLine,
  type ExportPointer,
  type PlacesFile,
  type PlacesIndex,
} from "@transitopia/shared/features.ts";
import {
  feedDataPath,
  versionDir,
  type ServicePlan,
} from "@transitopia/transit-core/plan/types.ts";
import {
  feedVersionFile,
  PUBLIC_DIR,
  readManifest,
  VAR_DIR,
  writeJson,
} from "./paths.ts";

/** A registry in its export form. */
export interface Registry {
  versions: Extract<ExportLine, { t: "version" }>[];
  features: Extract<ExportLine, { t: "feature" }>[];
  refs: Extract<ExportLine, { t: "ref" }>[];
}

/** Where the public export is published, relative to the data root's parent (var/public). */
export const FEATURES_DATA_PATH = "data/features";
export const EXPORT_POINTER = `${FEATURES_DATA_PATH}/latest.json`;
/** The local registry without a database: the last pulled export. */
export const LOCAL_REGISTRY = join(VAR_DIR, "features", "registry.ndjson.gz");

export function encodeRegistry(r: Registry): Buffer {
  const lines = [...r.versions, ...r.features, ...r.refs].map((l) =>
    JSON.stringify(l),
  );
  return gzipSync(`${lines.join("\n")}\n`);
}

/** Gzip's first two bytes. */
const isGzip = (b: Buffer) => b[0] === 0x1f && b[1] === 0x8b;

/**
 * An export's registry. Accepts it already gunzipped: a server sending the file with
 * `Content-Encoding: gzip` (Vite's, some CDN setups) has `fetch` decompress it.
 */
export function decodeRegistry(gz: Buffer): Registry {
  const r: Registry = { versions: [], features: [], refs: [] };
  const text = (isGzip(gz) ? gunzipSync(gz) : gz).toString("utf8");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const l = JSON.parse(line) as ExportLine;
    if (l.t === "version") r.versions.push(l);
    else if (l.t === "feature") r.features.push(l);
    else if (l.t === "ref") r.refs.push(l);
  }
  return r;
}

export async function readRegistryFile(path: string): Promise<Registry> {
  return decodeRegistry(await readFile(path));
}

/** Write the export for a date (YYYYMMDD) and point latest.json at it. Returns its path under the data root. */
export async function writeExport(
  r: Registry,
  date: string,
  root = PUBLIC_DIR,
): Promise<string> {
  const path = `${FEATURES_DATA_PATH}/export/${date}.ndjson.gz`;
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), encodeRegistry(r));
  const pointer: ExportPointer = {
    path,
    generatedAt: new Date().toISOString(),
    features: r.features.length,
  };
  await writeJson(join(root, EXPORT_POINTER), pointer);
  return path;
}

/** A registry's lookups for one feed version. */
class VersionView {
  readonly seq: number | undefined;
  private readonly refs = new Map<string, string>();
  readonly features: Map<string, Registry["features"][number]>;
  /** A stop's code: its newest stop ref in this version. */
  readonly codes = new Map<string, string>();

  constructor(r: Registry, feed: string, version: string) {
    this.features = new Map(r.features.map((f) => [f.id, f]));
    this.seq = r.versions.find(
      (v) => v.feed === feed && v.version === versionDir(version),
    )?.seq;
    const seq = this.seq;
    if (seq === undefined) return;
    for (const x of r.refs) {
      if (x.namespace !== feed) continue;
      if ((x.from !== null && seq < x.from) || (x.to !== null && seq >= x.to))
        continue;
      this.refs.set(`${x.scheme}\0${x.ref}`, x.feature);
      if (x.scheme === "stop") this.codes.set(x.feature, x.ref);
    }
  }

  at(scheme: string, value: string) {
    const id = this.refs.get(`${scheme}\0${value}`);
    return id === undefined ? undefined : this.features.get(id);
  }
}

/** A feature's key: its ID with its current name suffix. */
export function featureKey(
  f: Pick<Registry["features"][number], "id" | "kind" | "name">,
  code?: string,
): string {
  const k = parseKey(f.id);
  if (k?.form !== "id") throw new Error(`not an ID: ${f.id}`);
  return formatKey({ ...k, suffix: nameSuffix(f.kind, f.name, { code }) });
}

type PlanIds = Pick<ServicePlan, "stations" | "stops" | "routes">;

/**
 * A feed version's places file (without its `n`), or undefined when the registry hasn't reconciled
 * the version.
 */
export function buildPlaces(
  r: Registry,
  plan: PlanIds,
  feed: string,
  version: string,
): Omit<PlacesFile, "n"> | undefined {
  const v = new VersionView(r, feed, version);
  if (v.seq === undefined) return undefined;
  const out: Omit<PlacesFile, "n"> = {
    format: 1,
    feed,
    version,
    stations: {},
    stops: {},
    routes: {},
    parents: {},
    places: {},
    redirects: {},
  };
  const used = new Set<string>();
  const place = (id: string | null) => {
    const f = id ? v.features.get(id) : undefined;
    if (
      !f
      || (f.kind !== "station" && f.kind !== "exchange")
      || f.lon === null
      || f.lat === null
    )
      return undefined;
    used.add(f.id);
    out.places[f.id] ??= {
      kind: f.kind,
      key: featureKey(f),
      name: f.name,
      lon: f.lon,
      lat: f.lat,
    };
    return f.id;
  };
  for (const s of plan.stations) {
    const f = v.at("gtfs-stop", s.id);
    // A plan station is a parent stop, or a standalone rail stop (then its station's).
    const id =
      f?.kind === "station" ? f.id
      : f?.kind === "stop" ? f.parent
      : null;
    const p = place(id ?? null);
    if (p) out.stations[s.id] = out.places[p]!.key;
  }
  for (const s of plan.stops) {
    const f = v.at("gtfs-stop", s.id);
    if (f?.kind !== "stop") continue;
    used.add(f.id);
    out.stops[s.id] = featureKey(f, v.codes.get(f.id));
    const p = place(f.parent);
    if (p) out.parents[s.id] = p;
  }
  for (const route of plan.routes) {
    const f = v.at("gtfs-route", route.gtfsRouteId);
    if (f?.kind !== "route") continue;
    used.add(f.id);
    out.routes[route.key] ??= featureKey(f);
  }
  for (const f of r.features)
    if (f.mergedInto && used.has(f.mergedInto))
      out.redirects[f.id] = f.mergedInto;
  return out;
}

/** The index of a feed's places files, on disk. */
export function placesIndexPath(feed: string, root = PUBLIC_DIR): string {
  return join(root, feedDataPath(feed, undefined, "places.json"));
}

/**
 * Write a version's places file if its content changed (as `places.<n+1>.json`, the old file kept
 * for clients holding the old index) and point the index at it. Returns whether it wrote.
 */
export async function writePlaces(
  places: Omit<PlacesFile, "n">,
  root = PUBLIC_DIR,
): Promise<boolean> {
  const indexPath = placesIndexPath(places.feed, root);
  const index: PlacesIndex =
    existsSync(indexPath) ?
      (JSON.parse(await readFile(indexPath, "utf8")) as PlacesIndex)
    : { feed: places.feed, versions: {} };
  const current = index.versions[places.version];
  let n = 0;
  if (current && existsSync(join(root, current))) {
    const old = JSON.parse(
      await readFile(join(root, current), "utf8"),
    ) as PlacesFile;
    const { n: oldN, ...rest } = old;
    if (JSON.stringify(rest) === JSON.stringify(places)) return false;
    n = oldN;
  }
  const path = feedDataPath(
    places.feed,
    places.version,
    `places.${n + 1}.json`,
  );
  await writeJson(join(root, path), { ...places, n: n + 1 });
  index.versions[places.version] = path;
  await writeJson(indexPath, index);
  return true;
}

/**
 * Write the places files of every version in each feed's manifest that the registry has
 * reconciled. Returns the files written ("<feed>/<version>").
 */
export async function writeFeedPlaces(
  r: Registry,
  feeds: readonly string[],
  log: (msg: string) => void = () => {},
): Promise<string[]> {
  const written: string[] = [];
  for (const feed of feeds) {
    const manifest = await readManifest(feed);
    for (const entry of manifest.feeds) {
      const planPath = feedVersionFile(feed, entry.version, "plan.json");
      if (!existsSync(planPath)) continue;
      // Its ids are all in the core.
      const plan = decodeCore(await readPlanCore(planPath));
      const places = buildPlaces(r, plan, feed, entry.version);
      if (!places) {
        log(
          `features: ${feed} ${entry.version} isn't in the registry yet: no places file`,
        );
        continue;
      }
      if (await writePlaces(places)) written.push(`${feed}/${entry.version}`);
    }
  }
  if (written.length)
    log(`features: wrote places files for ${written.join(", ")}`);
  return written;
}
