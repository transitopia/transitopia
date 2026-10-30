// The cycling map's data: its published files (packages/cycling-core/README.md#published-files),
// the index for the area in config/cycling/cycling.json, read once a page load, naming the current
// tiles; and bike routes from the API server (apps/server/README.md#cycling-routes), read as cards
// need them.

import React from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
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

/** How long a bike route read from the server is kept: as long as the edge caches it. */
const ROUTE_STALE_MS = 3600_000;

/** React Query's key for a bike route, by the key it was asked for by. */
const routeQueryKey = (key: string) => ["cycling", "route", key] as const;

/** A bike route by `cr` ID or `osm-relation:` ref: null if the server doesn't know it. */
async function fetchRoute(key: string): Promise<CyclingRouteDetail | null> {
  if (!transitApi) throw new Error("no API server (VITE_TRANSIT_API)");
  const r = await fetch(
    `${transitApi}cycling/routes/${encodeURIComponent(key)}`,
  );
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as CyclingRouteDetail;
}

/**
 * Several bike routes' states, in the order of `keys`. Each is read once and kept for an hour (the
 * server's cache), also under the key the server names it by, so a ref rewritten to its ID shows
 * at once. A failure isn't retried: the card says the server can't be reached.
 */
export function useCyclingRoutes(keys: readonly string[]): RouteState[] {
  const queryClient = useQueryClient();
  return useQueries({
    queries: keys.map((key) => ({
      queryKey: routeQueryKey(key),
      queryFn: async () => {
        const route = await fetchRoute(key).catch((e: unknown) => {
          console.warn(`Couldn't read bike route ${key}:`, e);
          throw e;
        });
        if (route && route.key !== key)
          queryClient.setQueryData(routeQueryKey(route.key), route);
        return route;
      },
      staleTime: ROUTE_STALE_MS,
      retry: false,
    })),
    combine: (results) =>
      results.map((q): RouteState => {
        if (q.isPending) return { state: "loading" };
        if (q.isError) return { state: "unreachable" };
        return q.data ?
            { state: "found", route: q.data }
          : { state: "notFound" };
      }),
  });
}

/** A bike route's state; undefined for no key. */
export function useCyclingRoute(
  key: string | undefined,
): RouteState | undefined {
  const keys = React.useMemo(() => (key ? [key] : []), [key]);
  return useCyclingRoutes(keys)[0];
}
