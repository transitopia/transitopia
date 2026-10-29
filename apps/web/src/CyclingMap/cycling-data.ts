// The cycling map's published files (packages/cycling-core/README.md#published-files): the index
// for the area in config/cycling/cycling.json, read once a page load, names the current tiles.

import React from "react";
import { parseConfig } from "@transitopia/transit-core/config.ts";
import {
  CYCLING_INDEX,
  cyclingDataPath,
  type CyclingIndex,
} from "@transitopia/cycling-core/published.ts";
import cyclingJson from "../../../../config/cycling/cycling.json";
import { transitData } from "../config.ts";

const { area } = parseConfig("cycling", cyclingJson);

let tilesUrl: Promise<string> | undefined;

/** The current tiles' absolute URL, from the index (fetched once). */
function loadTiles(): Promise<string> {
  tilesUrl ??= (async () => {
    const url = new URL(
      cyclingDataPath(area.id, CYCLING_INDEX),
      new URL(transitData, location.href),
    );
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url.href}: HTTP ${r.status}`);
    return new URL(((await r.json()) as CyclingIndex).tiles, url).href;
  })();
  // A failed read is tried again the next time the cycling map opens.
  tilesUrl.catch(() => (tilesUrl = undefined));
  return tilesUrl;
}

/** The cycling tiles' source URL (pmtiles://…), once the index is read. */
export function useCyclingTiles(): string | undefined {
  const [tiles, setTiles] = React.useState<string>();
  React.useEffect(() => {
    let live = true;
    loadTiles().then(
      (url) => live && setTiles(`pmtiles://${url}`),
      (e: unknown) => console.warn("Couldn't read the cycling index:", e),
    );
    return () => {
      live = false;
    };
  }, []);
  return tiles;
}
