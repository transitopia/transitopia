// The cycling map's data: its published files (packages/cycling-core/README.md#published-files),
// the index for the area in config/cycling/cycling.json, read once a page load, naming the current
// tiles; and bike routes from the API server (apps/server/README.md#cycling-routes), read as cards
// need them.

import React from "react";
import { parseConfig } from "@transitopia/transit-core/config.ts";
import {
  CYCLING_INDEX,
  cyclingDataPath,
  type CyclingIndex,
} from "@transitopia/cycling-core/published.ts";
import type { CyclingRouteDetail } from "@transitopia/cycling-core/routes.ts";
import cyclingJson from "../../../../config/cycling/cycling.json";
import { transitApi, transitData } from "../config.ts";

const { area } = parseConfig("cycling", cyclingJson);

/** The current files' absolute URLs. */
interface CyclingFiles {
  tiles: string;
}

let files: Promise<CyclingFiles> | undefined;

/** The current files, from the index (fetched once). */
function loadFiles(): Promise<CyclingFiles> {
  files ??= (async () => {
    const url = new URL(
      cyclingDataPath(area.id, CYCLING_INDEX),
      new URL(transitData, location.href),
    );
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url.href}: HTTP ${r.status}`);
    const index = (await r.json()) as CyclingIndex;
    return { tiles: new URL(index.tiles, url).href };
  })();
  // A failed read is tried again the next time the cycling map opens.
  files.catch(() => (files = undefined));
  return files;
}

/** The cycling tiles' source URL (pmtiles://…), once the index is read. */
export function useCyclingTiles(): string | undefined {
  const [tiles, setTiles] = React.useState<string>();
  React.useEffect(() => {
    let live = true;
    loadFiles().then(
      (f) => live && setTiles(`pmtiles://${f.tiles}`),
      (e: unknown) => console.warn("Couldn't read the cycling index:", e),
    );
    return () => {
      live = false;
    };
  }, []);
  return tiles;
}

/**
 * What the API server (apps/server/README.md#cycling-routes) says of a bike route: loading, its
 * card's data, not a route it knows, or that the server couldn't be reached (or none is set).
 */
export type RouteState =
  | { state: "loading" }
  | { state: "found"; route: CyclingRouteDetail }
  | { state: "notFound" }
  | { state: "unreachable" };

/** Routes asked for by key (as asked, and as the server names them); a failed request is dropped. */
const routeRequests = new Map<
  string,
  Promise<CyclingRouteDetail | undefined>
>();
/** What those requests answered, so a route already read shows at once. */
const routeAnswers = new Map<string, RouteState>();

/** A bike route by `cr` ID or `osm-relation:` ref: undefined if the server doesn't know it. */
function fetchRoute(key: string): Promise<CyclingRouteDetail | undefined> {
  let p = routeRequests.get(key);
  if (p) return p;
  p = (async () => {
    if (!transitApi) throw new Error("no API server (VITE_TRANSIT_API)");
    const r = await fetch(
      `${transitApi}cycling/routes/${encodeURIComponent(key)}`,
    );
    if (r.status === 404) return undefined;
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const route = (await r.json()) as CyclingRouteDetail;
    routeRequests.set(route.key, Promise.resolve(route));
    routeAnswers.set(route.key, { state: "found", route });
    return route;
  })();
  routeRequests.set(key, p);
  p.catch(() => routeRequests.delete(key));
  return p;
}

/** Several bike routes' states, in the order of `keys`. */
export function useCyclingRoutes(keys: readonly string[]): RouteState[] {
  const id = keys.join(" ");
  const [states, setStates] = React.useState<{
    id: string;
    states: RouteState[];
  }>();
  React.useEffect(() => {
    let live = true;
    const list = id ? id.split(" ") : [];
    void Promise.all(
      list.map((k) =>
        fetchRoute(k).then(
          (route): RouteState => {
            const s: RouteState =
              route ? { state: "found", route } : { state: "notFound" };
            routeAnswers.set(k, s);
            return s;
          },
          (e: unknown): RouteState => {
            console.warn(`Couldn't read bike route ${k}:`, e);
            return { state: "unreachable" };
          },
        ),
      ),
    ).then((s) => live && setStates({ id, states: s }));
    return () => {
      live = false;
    };
  }, [id]);
  return states?.id === id ?
      states.states
    : keys.map((k) => routeAnswers.get(k) ?? { state: "loading" });
}

/** A bike route's state; undefined for no key. */
export function useCyclingRoute(
  key: string | undefined,
): RouteState | undefined {
  const keys = React.useMemo(() => (key ? [key] : []), [key]);
  return useCyclingRoutes(keys)[0];
}
