// Feature IDs and refs (docs/DESIGN.md#feature-ids): the two forms of string that name a feature,
// told apart by their characters alone. A ref contains ":" (`gtfs-stop:translink:12034`); anything
// else must be an ID (`sn-k3v9qd7m`, optionally with a decorative name suffix:
// `sn-k3v9qd7m-waterfront`). Used by the site, the server and the pipelines.

/** Kinds of feature, and the prefix of their IDs. A feature's kind never changes. */
export const KIND_PREFIXES = {
  station: "sn",
  exchange: "ex",
  stop: "st",
  route: "rt",
  vehicle: "vh",
  "cycling-route": "cr",
  "cycling-way": "cw",
  "bike-parking": "bp",
  "bikeshare-station": "mm",
} as const;

export type FeatureKind = keyof typeof KIND_PREFIXES;
export const FEATURE_KINDS = Object.keys(KIND_PREFIXES) as FeatureKind[];

/** Prefixes kept for kinds to come: annotations and photos. */
export const RESERVED_PREFIXES = ["an", "ph"] as const;

const KIND_OF_PREFIX = new Map<string, FeatureKind>(
  FEATURE_KINDS.map((k) => [KIND_PREFIXES[k], k]),
);

/**
 * Ref schemes, and whether each has a namespace (a feed, operator or GBFS system). `run` and
 * `shared` are the engine's own, never the registry's: `run:<run id>`, and `shared:<from>:<to>`, a
 * combined route between two stops or stations, each named by its key.
 */
export const REF_SCHEMES = {
  "gtfs-stop": true,
  "gtfs-route": true,
  stop: true,
  rt: true,
  fleet: true,
  "ais-mmsi": false,
  "osm-node": false,
  "osm-way": false,
  "osm-relation": false,
  onestop: false,
  "gbfs-station": true,
  run: false,
  shared: false,
} as const;

export type RefScheme = keyof typeof REF_SCHEMES;

/** Schemes whose refs hold over a range of their feed's versions (feature_refs.versions). */
export const VERSIONED_SCHEMES = [
  "gtfs-stop",
  "gtfs-route",
  "stop",
] as const satisfies RefScheme[];

/** Lowercase Crockford base32: no i, l, o or u. */
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const ID_CHARS = 8;
/** An ID, with an optional name suffix. */
const ID_PATTERN = /^([a-z]{2,3})-([0-9a-hjkmnp-tv-z]{8})((?:-[a-z0-9]+)*)$/;

export interface FeatureId {
  form: "id";
  /** The ID without its suffix: what's stored and compared. */
  id: string;
  kind: FeatureKind;
  /** The name suffix as written ("waterfront"), or "". Lookups ignore it. */
  suffix: string;
}

export interface FeatureRef {
  form: "ref";
  scheme: RefScheme;
  /** "" for a scheme without one. */
  namespace: string;
  value: string;
}

export type FeatureKey = FeatureId | FeatureRef;

/**
 * An ID or ref, or undefined if the string is neither (an unknown scheme or prefix, a missing
 * namespace, or not the ID pattern). Contains ":" → a ref, else an ID.
 */
export function parseKey(s: string): FeatureKey | undefined {
  const colon = s.indexOf(":");
  if (colon < 0) {
    const m = ID_PATTERN.exec(s);
    const kind = m && KIND_OF_PREFIX.get(m[1]!);
    if (!m || !kind) return undefined;
    return {
      form: "id",
      id: `${m[1]}-${m[2]}`,
      kind,
      suffix: m[3]!.slice(1),
    };
  }
  const scheme = s.slice(0, colon);
  if (!Object.hasOwn(REF_SCHEMES, scheme)) return undefined;
  const rest = s.slice(colon + 1);
  if (!REF_SCHEMES[scheme as RefScheme])
    return rest ?
        { form: "ref", scheme: scheme as RefScheme, namespace: "", value: rest }
      : undefined;
  const second = rest.indexOf(":");
  if (second <= 0 || second === rest.length - 1) return undefined;
  return {
    form: "ref",
    scheme: scheme as RefScheme,
    namespace: rest.slice(0, second),
    value: rest.slice(second + 1),
  };
}

/** The site's map modes (apps/web/README.md#modes-and-url-state). */
export type MapMode = "transit" | "cycling";

/** The mode that shows a kind of feature. */
export function modeOfKind(kind: FeatureKind): MapMode {
  return (
      kind === "cycling-route"
        || kind === "cycling-way"
        || kind === "bike-parking"
        || kind === "bikeshare-station"
    ) ?
      "cycling"
    : "transit";
}

/**
 * The mode that shows what a key names: its kind's for an ID, else its scheme's. Undefined for an
 * OSM ref, which a feature of either mode may have (a station may carry an `osm-node` ref): the
 * feature resolver knows which.
 */
export function modeOfKey(k: FeatureKey): MapMode | undefined {
  if (k.form === "id") return modeOfKind(k.kind);
  if (k.scheme.startsWith("osm-")) return undefined;
  return k.scheme === "gbfs-station" ? "cycling" : "transit";
}

/** A key as a string: an ID with its suffix, if it has one, or a ref. */
export function formatKey(k: FeatureKey): string {
  if (k.form === "id") return k.suffix ? `${k.id}-${k.suffix}` : k.id;
  return k.namespace ?
      `${k.scheme}:${k.namespace}:${k.value}`
    : `${k.scheme}:${k.value}`;
}

/** A ref's string form. */
export function formatRef(
  scheme: RefScheme,
  namespace: string,
  value: string,
): string {
  return formatKey({ form: "ref", scheme, namespace, value });
}

/** Whether a string is an ID without a suffix, as stored. */
export function isFeatureId(s: string): boolean {
  const k = parseKey(s);
  return k?.form === "id" && k.id === s;
}

/** The kind an ID's prefix names. */
export function kindOfId(id: string): FeatureKind | undefined {
  const k = parseKey(id);
  return k?.form === "id" ? k.kind : undefined;
}

/**
 * A new random ID of a kind. `random` fills a byte array (crypto random bytes in production; a
 * seeded source in tests). The caller checks it against every existing ID and draws again on a clash.
 */
export function mintId(
  kind: FeatureKind,
  random: (bytes: Uint8Array) => Uint8Array,
): string {
  const bytes = random(new Uint8Array(ID_CHARS));
  let s = "";
  // 32 divides 256, so each byte's low five bits are uniform.
  for (const b of bytes) s += ALPHABET[b & 31];
  return `${KIND_PREFIXES[kind]}-${s}`;
}

/** At most this many characters of a name suffix. */
const SUFFIX_MAX = 64;

/**
 * A name as a URL suffix: lowercase, accents stripped, "&" as "and", every run of other characters
 * a "-", at most 64 characters.
 */
export function slugifyName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, SUFFIX_MAX)
    .replace(/^-+|-+$/g, "");
}

/**
 * A feature's name suffix: stations without a trailing "Station" ("waterfront"), stops by their
 * stop code if they have one ("50123"), routes by their short name ("99") else long name.
 */
export function nameSuffix(
  kind: FeatureKind,
  name: string,
  opts: { code?: string | undefined } = {},
): string {
  if (kind === "stop" && opts.code) return slugifyName(opts.code);
  if (kind === "station")
    return slugifyName(name.replace(/\s+Station\s*$/i, ""));
  return slugifyName(name);
}

/**
 * A feed version's places file (data/feeds/<feed>/<version>/places.<n>.json, docs/DESIGN.md#published-features):
 * the registry's IDs for the plan's own ids, which station or exchange each stop is in, and
 * redirects. Written from the registry; `n` increments whenever the content changes, so each file
 * is immutable. `places.json` beside the manifest names each version's current file.
 */
export interface PlacesFile {
  format: 1;
  feed: string;
  version: string;
  n: number;
  /** Plan station id → the station's key (its ID with its name suffix). */
  stations: Record<string, string>;
  /** stop_id → the stop's key. */
  stops: Record<string, string>;
  /** The plan's route key → the route's key. */
  routes: Record<string, string>;
  /** stop_id → the ID of the station or exchange it's in. */
  parents: Record<string, string>;
  /** Each station and exchange its stops are in, by ID. */
  places: Record<
    string,
    {
      kind: "station" | "exchange";
      key: string;
      name: string;
      lon: number;
      lat: number;
    }
  >;
  /** IDs merged into the features above → the ID they were merged into. */
  redirects: Record<string, string>;
}

/** data/feeds/<feed>/places.json: each version's current places file (a path under the data root). */
export interface PlacesIndex {
  feed: string;
  versions: Record<string, string>;
}

/**
 * The public registry export (data/features/export/<YYYYMMDD>.ndjson.gz, one JSON object a line),
 * and the form `npm run features -- pull` loads. Ranges of refs are over `seq`, the export's
 * numbering of feed versions (its "version" lines).
 */
export type ExportLine =
  | {
      t: "version";
      feed: string;
      version: string;
      seq: number;
      start: string;
      end: string;
      sha256: string;
      bytes: number;
    }
  | {
      t: "feature";
      id: string;
      kind: FeatureKind;
      name: string;
      lon: number | null;
      lat: number | null;
      parent: string | null;
      status: "active" | "retired" | "merged";
      mergedInto: string | null;
      operator: string | null;
      feed: string | null;
    }
  | {
      t: "ref";
      feature: string;
      scheme: string;
      namespace: string;
      ref: string;
      /** [from, to) over seq; null for unbounded. */
      from: number | null;
      to: number | null;
    };

/** data/features/latest.json. */
export interface ExportPointer {
  path: string;
  generatedAt: string;
  features: number;
}
