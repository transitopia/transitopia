// The cycling map's published files (packages/cycling-core/README.md#published-files): the index
// for the area in config/cycling/cycling.json, read once a page load, names the current tiles and
// bike routes.

import React from "react";
import { parseConfig } from "@transitopia/transit-core/config.ts";
import {
  CYCLING_INDEX,
  cyclingDataPath,
  type CyclingIndex,
  type CyclingRoutes,
} from "@transitopia/cycling-core/published.ts";
import cyclingJson from "../../../../config/cycling/cycling.json";
import { transitData } from "../config.ts";

const { area } = parseConfig("cycling", cyclingJson);

/** The current files' absolute URLs. */
interface CyclingFiles {
  tiles: string;
  routes: string;
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
    return {
      tiles: new URL(index.tiles, url).href,
      routes: new URL(index.routes, url).href,
    };
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

let routes: Promise<CyclingRoutes> | undefined;

/** The bike routes, by relation id (fetched once, when first needed). */
function loadRoutes(): Promise<CyclingRoutes> {
  routes ??= (async () => {
    const url = (await loadFiles()).routes;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return (await r.json()) as CyclingRoutes;
  })();
  routes.catch(() => (routes = undefined));
  return routes;
}

/** The bike routes, once read: only when `needed` (a selected route, or a path in some). */
export function useCyclingRoutes(needed: boolean): CyclingRoutes | undefined {
  const [data, setData] = React.useState<CyclingRoutes>();
  React.useEffect(() => {
    if (!needed || data) return;
    let live = true;
    loadRoutes().then(
      (r) => live && setData(r),
      (e: unknown) => console.warn("Couldn't read the bike routes:", e),
    );
    return () => {
      live = false;
    };
  }, [needed, data]);
  return data;
}
