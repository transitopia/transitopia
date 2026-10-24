// Which of a feed's GTFS routes a plan draws, and how (packages/transit-core/DESIGN.md#routes): every
// route by default, modelled from its GTFS route_type, with the feed's routes.json overriding some
// (matched by name, never route_id) and excluding others.

import type { Config, RouteConfig, RouteMatch } from "../config.ts";
import type { PlanRoute, RouteKind, RouteMode } from "./types.ts";

/** The routes.txt fields this reads. */
export interface GtfsRouteRow {
  route_id?: string | undefined;
  route_short_name?: string | undefined;
  route_long_name?: string | undefined;
  route_type?: string | undefined;
  route_color?: string | undefined;
  route_text_color?: string | undefined;
}

interface Model {
  kind: RouteKind;
  mode: RouteMode;
}

const BUS: Model = { kind: "bus", mode: "bus" };
const RAIL: Model = { kind: "shape", mode: "rail" };
const FERRY: Model = { kind: "shape", mode: "ferry" };

/**
 * How a route is modelled without an entry in routes.json, from its GTFS route_type (basic and
 * extended types). Buses run on GTFS-RT; rail and ferries along their shapes (track-level rail
 * needs an entry: kind "skytrain"). Anything else (trams, cable cars, demand-responsive service
 * such as type 715) is left out unless routes.json says how to draw it.
 */
export function defaultModel(routeType: string | undefined): Model | undefined {
  const t = Number(routeType);
  if (t === 3 || t === 11 || (t >= 700 && t < 800 && t !== 715) || t === 800)
    return BUS;
  if (
    t === 1
    || t === 2
    || t === 12
    || (t >= 100 && t < 200)
    || (t >= 400 && t < 500)
  )
    return RAIL;
  if (t === 4 || t === 1000 || t === 1200) return FERRY;
  return undefined;
}

/**
 * A route's key without an override: its short name as riders know it ("025" → "25", "N17"), else
 * its long name in lower case with dashes ("SeaBus" → "seabus").
 */
export function defaultKey(row: GtfsRouteRow): string | undefined {
  const short = (row.route_short_name ?? "").trim();
  if (short) return short.replace(/^0+(?=\d)/, "");
  const long = (row.route_long_name ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return long || undefined;
}

/** "25 King Edward", "N17 UBC/Downtown Night Bus", "SeaBus". */
export function defaultLabel(row: GtfsRouteRow, key: string): string {
  const short = (row.route_short_name ?? "").trim();
  const long = (row.route_long_name ?? "").trim();
  if (!short) return long || key;
  return long ? `${key} ${long}` : key;
}

export function matches(row: GtfsRouteRow, m: RouteMatch): boolean {
  return Object.entries(m).every(
    ([field, value]) =>
      (row[field as keyof GtfsRouteRow] ?? "").trim().toLowerCase()
      === value.toLowerCase(),
  );
}

function hexColor(v: string | undefined, fallback: string): string {
  return v && /^[0-9a-f]{6}$/i.test(v) ? `#${v.toLowerCase()}` : fallback;
}

/** Without a GTFS colour (TransLink's buses have none): drawn by frequency anyway. */
const NO_COLOR = "#666666";
/** Rail and ferries first, then buses in their own colour, then the other buses. */
const groupOf = (r: PlanRoute) =>
  r.mode !== "bus" ? 0
  : r.brand ? 1
  : 2;
const byNumber = new Intl.Collator(undefined, { numeric: true });

export interface RouteSelection {
  routes: PlanRoute[];
  /** Routes left out, and why (excluded, or a route_type with no default model). */
  skipped: { row: GtfsRouteRow; reason: string }[];
  /** routes.json entries that matched no route in the feed (not an error: routes come and go). */
  unmatched: RouteConfig[];
}

/**
 * The plan's routes from a feed's routes.txt and its routes.json. Sorted by group (rail and
 * ferries, buses in their own colour, other buses), then as listed in routes.json, then by key, numbers in order. Throws when an
 * entry matches more than one route, or two routes would share a key.
 */
export function selectRoutes(
  rows: readonly GtfsRouteRow[],
  cfg: Config<"routes">,
  dataset: string | undefined,
): RouteSelection {
  const routes: PlanRoute[] = [];
  const skipped: RouteSelection["skipped"] = [];
  const used = new Set<RouteConfig>();
  for (const row of rows) {
    if (cfg.exclude?.some((x) => matches(row, x.match))) {
      skipped.push({ row, reason: "excluded in routes.json" });
      continue;
    }
    const over = cfg.routes.find((c) => matches(row, c.match));
    if (over && used.has(over))
      throw new Error(
        `routes.json: ${over.key} matches more than one GTFS route`,
      );
    if (over) used.add(over);
    const model = defaultModel(row.route_type);
    if (!model && !(over?.kind && over.mode)) {
      skipped.push({
        row,
        reason: `route_type ${row.route_type ?? "(none)"} has no default model: add it to routes.json (kind, mode) or exclude it`,
      });
      continue;
    }
    const key = over?.key ?? defaultKey(row);
    if (!key) {
      skipped.push({
        row,
        reason: "no name to key it by: add it to routes.json",
      });
      continue;
    }
    if (routes.some((r) => r.key === key))
      throw new Error(
        `Two routes have the key ${key} (GTFS route ${row.route_id}): give one a key in routes.json`,
      );
    const mode = over?.mode ?? model!.mode;
    routes.push({
      key,
      label: over?.label ?? defaultLabel(row, key),
      kind: over?.kind ?? model!.kind,
      mode,
      brand: over?.brand ?? mode !== "bus",
      color: over?.color ?? hexColor(row.route_color, NO_COLOR),
      textColor: hexColor(row.route_text_color, "#ffffff"),
      gtfsRouteId: row.route_id!,
      ...(dataset ? { dataset } : {}),
    });
  }
  const listed = (k: string) => {
    const i = cfg.routes.findIndex((c) => c.key === k);
    return i < 0 ? Infinity : i;
  };
  routes.sort(
    (a, b) =>
      groupOf(a) - groupOf(b)
      || listed(a.key) - listed(b.key)
      || byNumber.compare(a.key, b.key),
  );
  return {
    routes,
    skipped,
    unmatched: cfg.routes.filter((c) => !used.has(c)),
  };
}
