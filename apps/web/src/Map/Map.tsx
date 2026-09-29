import React from "react";
import * as pmtiles from "pmtiles";
// Since v6, MapLibre GL loads its web worker from a separate file, whose URL it guesses relative to
// its own module URL. That guess is wrong once a bundler is involved, so we have Vite build the
// worker (and its dependencies) as a chunk of our app, and tell MapLibre GL where to find it.
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import type { StyleSpecification } from "maplibre-gl";
import { basemapStyle, type Theme } from "@transitopia/map-style/basemap.ts";

import {
  basemapAssets,
  basemapTiles,
  cyclingTiles,
  needPmTiles,
} from "../config.ts";
import { useTheme } from "../Theme/Theme.tsx";
import {
  MapContext,
  MapLibreGLContext,
  type MapLibreGLType,
  type MapType,
} from "./MapUtils.ts";

/** Where the basemap has tiles (BC, V2-PLAN.md §5.12), with some margin. */
const MAX_BOUNDS: [[number, number], [number, number]] = [
  [-142, 46],
  [-112, 62],
];
const DEFAULT_VIEW = {
  center: [-123.135, 49.272] as [number, number],
  zoom: 13,
};

// A global to track loading of pmtiles
let pmTilesInitialized = false;

/** The site's style for a theme: the basemap plus the (always available) overlay sources. */
function siteStyle(theme: Theme): StyleSpecification {
  const style = basemapStyle({
    theme,
    tiles: basemapTiles,
    assets: basemapAssets,
    sprites: [
      { id: "transitopia", url: `${location.origin}/transitopia-sprites` },
    ],
  });
  style.sources["transitopia-cycling"] = { type: "vector", url: cyclingTiles };
  return style as StyleSpecification;
}

/**
 * Before V2 the map position was in the query string (?z=&lat=&lng=). It's now in the hash
 * (#map=z/lat/lng, shared by every mode), so convert old links.
 */
function migrateLegacyPosition(): void {
  const url = new URL(location.href);
  const z = url.searchParams.get("z");
  const lat = url.searchParams.get("lat");
  const lng = url.searchParams.get("lng");
  if (z === null || lat === null || lng === null) return;
  for (const k of ["z", "lat", "lng"]) url.searchParams.delete(k);
  if (!url.hash.includes("map=")) {
    const n = (s: string) => Number(Number(s).toFixed(5));
    url.hash = `map=${n(z)}/${n(lat)}/${n(lng)}`;
  }
  history.replaceState(history.state, "", url);
}

export const Map: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const maplibregl = React.useContext(MapLibreGLContext).maplibregl;
  if (!maplibregl) {
    throw new Error(
      "<Map> cannot render without MapLibreGLContext. Add <AsyncMapLibreGLLoader> around <Map>.",
    );
  }
  const { theme } = useTheme();
  const [map, setMap] = React.useState<MapType>();
  const [styleGeneration, setStyleGeneration] = React.useState(0);
  const themeRef = React.useRef(theme);

  React.useEffect(() => {
    if (needPmTiles && !pmTilesInitialized) {
      // Load the "pmtiles" protocol that allows us to serve all the vector tiles for the map from a single large static .pmtiles file.
      const protocol = new pmtiles.Protocol();
      maplibregl.addProtocol("pmtiles", protocol.tile);
      pmTilesInitialized = true;
    }
    migrateLegacyPosition();

    const map = new maplibregl.Map({
      container: "map",
      ...DEFAULT_VIEW,
      hash: "map",
      maxBounds: MAX_BOUNDS,
      style: siteStyle(themeRef.current),
      // Credits come from our own control, for exactly the data on screen (V2-PLAN.md §4.6).
      attributionControl: false,
      pitchWithRotate: false,
    });
    map.addControl(
      new maplibregl.NavigationControl({ visualizePitch: false }),
      "top-right",
    );
    map.addControl(
      new maplibregl.ScaleControl({ unit: "metric" }),
      "bottom-left",
    );
    map.getCanvas().style.cursor = "default";

    let loaded = false;
    map.on("load", () => {
      loaded = true;
      setMap(map);
    });
    map.on("style.load", () => {
      if (loaded) setStyleGeneration((g) => g + 1);
    });

    return () => {
      // map.remove() deletes #map=… from the URL; keep it (React StrictMode remounts in development,
      // and the position should survive the map being recreated).
      const hash = location.hash;
      map.remove();
      if (hash && location.hash !== hash)
        history.replaceState(
          history.state,
          "",
          `${location.pathname}${location.search}${hash}`,
        );
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Theme switch: swap the style. Overlays re-add their layers when it loads (styleGeneration).
  React.useEffect(() => {
    if (theme === themeRef.current) return;
    themeRef.current = theme;
    map?.setStyle(siteStyle(theme));
  }, [map, theme]);

  const value = React.useMemo(
    () => ({ map, styleGeneration }),
    [map, styleGeneration],
  );
  return (
    <MapContext.Provider value={value}>
      <div id="map" className="w-screen h-dvh"></div>
      {children}
    </MapContext.Provider>
  );
};

/**
 * MapLibreGL JS is a _huge_ dependency, so we load it asynchronously and display a loading message
 * while it's loading. Simply wrap any map components in this loader component.
 */
export const AsyncMapLibreGLLoader: React.FC<{
  children: React.ReactNode;
  loadingContent: React.ReactNode;
}> = ({ children, loadingContent }) => {
  const [maplibregl, setMaplibregl] = React.useState<MapLibreGLType>();

  React.useEffect(() => {
    void (async function () {
      const maplibregl = await import("maplibre-gl");
      maplibregl.setWorkerUrl(maplibreWorkerUrl);
      setMaplibregl(maplibregl);
    })();
  }, []);

  if (maplibregl) {
    // MapLibreGL JS has loaded. Render the children, and make 'maplibregl' available to them via context:
    return React.createElement(
      MapLibreGLContext.Provider,
      {
        value: { maplibregl },
      },
      children,
    );
  } else {
    // It hasn't loaded yet. Display the loading message.
    return loadingContent;
  }
};
