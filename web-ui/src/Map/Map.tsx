import React from "react";
import * as pmtiles from "pmtiles";

import { layers, mapSource } from "./basemap-layers.ts";
import {
  MapContext,
  MapLibreGLContext,
  type MapLibreGLType,
} from "./MapUtils.ts";

/** Constrain a numeric value to a certain range */
const constrain = (value: number, min: number, max: number, def: number) =>
  isNaN(value) ? def : value > max ? max : value < min ? min : value;
/** Where we load our map tiles from */
const sourceUrlBase = import.meta.env.VITE_BASE_MAP_TILES_CDN ??
  "pmtiles://transitopia-base-bc.pmtiles";
const sourceUrlCycling = import.meta.env.VITE_CYCLING_MAP_TILES_CDN ??
  "pmtiles://transitopia-cycling-british-columbia.pmtiles";
/** Do we need to load the PMTiles library? */
const needPmTiles = [sourceUrlBase, sourceUrlCycling].some((url) =>
  url.startsWith("pmtiles://")
);
// A global to track loading of pmtiles
let pmTilesInitialized = false;

export const Map: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const maplibregl = React.useContext(MapLibreGLContext).maplibregl;
  if (!maplibregl) {
    throw new Error(
      "<Map> cannot render without MapLibreGLContext. Add <AsyncMapLibreGLLoader> around <Map>.",
    );
  }

  const [map, setMap] = React.useState<maplibregl.Map>();

  React.useEffect(() => {
    // Load the map dependencies asynchronously via a separate bundle:
    if (needPmTiles && !pmTilesInitialized) {
      // Load the "pmtiles" protocol that allows us to serve all the vector tiles for the map from a single large static .pmtiles file.
      const protocol = new pmtiles.Protocol();
      maplibregl.addProtocol("pmtiles", protocol.tile);
      pmTilesInitialized = true;
    }
    const initialUrl = new URL(location.href);
    const initialZoom = constrain(
      parseFloat(initialUrl.searchParams.get("z") ?? ""),
      5,
      20,
      10,
    );
    const initialLng = constrain(
      parseFloat(initialUrl.searchParams.get("lng") ?? ""),
      -140,
      -115,
      -122.94536684722912,
    );
    const initialLat = constrain(
      parseFloat(initialUrl.searchParams.get("lat") ?? ""),
      47,
      60,
      49.241584389313424,
    );

    const map = new maplibregl.Map({
      container: "map",
      zoom: initialZoom,
      center: [initialLng, initialLat], // starting position [lng, lat]
      style: {
        version: 8,
        name: "Transitopia",
        glyphs: "https://fonts.openmaptiles.org/{fontstack}/{range}.pbf",
        sprite: "https://openmaptiles.github.io/positron-gl-style/sprite",
        sources: {
          [mapSource]: {
            type: "vector",
            url: sourceUrlBase,
            attribution:
              'Map: <a href="https://openstreetmap.org">OpenStreetMap</a> + <a href="https://openmaptiles.org/">OpenMapTiles </a> + <a href="https://maplibre.org/">MapLibre</a>',
          },
          "transitopia-cycling": {
            type: "vector",
            url: sourceUrlCycling,
            attribution: "",
          },
        },
        layers,
      },
    });
    map.getCanvas().style.cursor = "default";

    const handleMapViewChanged = () => {
      const zoom = map.getZoom();
      const { lng, lat } = map.getCenter();
      const url = new URL(location.href);
      url.searchParams.set("z", zoom.toFixed(4));
      url.searchParams.set("lat", lat.toFixed(10));
      url.searchParams.set("lng", lng.toFixed(10));
      history.replaceState({ zoom, lng, lat }, "", url.pathname + url.search);
    };

    map.on("zoomend", handleMapViewChanged);
    map.on("moveend", handleMapViewChanged);
    map.on("load", () => {
      setMap(map);
    });

    // Cleanup:
    return () => {
      console.log("Destroying map");
      map.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <MapContext.Provider value={{ map }}>
      <div id="map" className="w-screen h-screen"></div>
      {children};
    </MapContext.Provider>
  );
};

/**
 * MapLibreGL JS is a _huge_ dependency, so we load it asynchronously and display a loading message
 * while it's loading. Simply wrap any map components in this loader component.
 */
export const AsyncMapLibreGLLoader: React.FC<
  { children: React.ReactNode; loadingContent: React.ReactNode }
> = ({ children, loadingContent }) => {
  const [maplibregl, setMaplibregl] = React.useState<MapLibreGLType>();

  React.useEffect(() => {
    (async function () {
      const maplibregl = await import("maplibre-gl");
      setMaplibregl(maplibregl);
    })();
  }, []);

  if (maplibregl) {
    // MapLibreGL JS has loaded. Render the children, and make 'maplibregl' available to them via context:
    return React.createElement(MapLibreGLContext.Provider, {
      value: { maplibregl },
    }, children);
  } else {
    // It hasn't loaded yet. Display the loading message.
    return loadingContent;
  }
};
