import React from "react";
import type * as MapLibreGL from "maplibre-gl";

import { useLocation, useSearchParams } from "wouter";

import {
  cyclingFilters,
  cyclingLayers,
  mapSource,
  otherLayerIds,
  pathLayerIds,
  SELECTED_ROUTE,
} from "./cycling-map-layers.ts";
import {
  useMap,
  useMapLayerEvent,
  useStyleGeneration,
  type MapType,
} from "../Map/MapUtils.ts";
import {
  CYCLING_DETAIL_ZOOM,
  CYCLING_LAYER,
} from "@transitopia/cycling-core/tiles.ts";
import type { BBox } from "@transitopia/cycling-core/lookup.ts";
import { modeOfKind, type FeatureKind } from "@transitopia/shared/features.ts";
import { useTheme } from "../Theme/Theme.tsx";
import { useDatasets } from "../Attribution/Attribution.tsx";
import { MapOverlayWindow } from "../Map/MapOverlayWindow.tsx";
import { modeUrl, useOtherModeRedirect } from "../components/ModeLink.tsx";
import { transitApi } from "../config.ts";
import { openedWithPosition } from "../startup.ts";
import { BikeParkingCard } from "./BikeParkingCard.tsx";
import { BikePathCard, pathTitle } from "./BikePathCard.tsx";
import { CyclingRouteCard } from "./CyclingRouteCard.tsx";
import { CyclingLayers, useCyclingShow } from "./CyclingLayers.tsx";
import { useCyclingRoutes, useCyclingTiles } from "./cycling-data.ts";
import {
  asElement,
  findLoaded,
  keyOfElement,
  osmRef,
  selectKey,
  writeSelect,
  type CyclingElement,
} from "./cycling-select.ts";

/** A path or bike parking, as found in the tiles. */
interface FoundElement {
  kind: "element";
  key: string;
  element: CyclingElement;
  /** A point on it, for "Centre on map". */
  at: [number, number];
}

/**
 * What the map knows of the key in ?select= (apps/web/README.md#cycling-links), which is the
 * selection: the path or bike parking it names, a bike route's way back to the path card it was
 * opened from, or that it couldn't be found. Kept while the URL names that key.
 */
type Found =
  | FoundElement
  | { kind: "route"; key: string; from: FoundElement }
  | { kind: "notFound"; key: string };

const PADDING = { top: 90, bottom: 150, left: 20, right: 50 };

/** Move the map to show bounds, zoomed in at least as far as paths can be selected. */
function showBounds(map: MapType, b: BBox, animate: boolean): void {
  const camera = map.cameraForBounds(
    [
      [b[0], b[1]],
      [b[2], b[3]],
    ],
    { padding: PADDING, maxZoom: 17 },
  );
  if (!camera) return;
  const to = {
    ...camera,
    zoom: Math.max(camera.zoom ?? CYCLING_DETAIL_ZOOM, CYCLING_DETAIL_ZOOM),
  };
  if (animate) map.flyTo(to);
  else map.jumpTo(to);
}

/** Once the map has drawn the cycling tiles where it is now. */
const whenIdle = (map: MapType) =>
  new Promise<void>((resolve) => {
    if (map.loaded() && map.isSourceLoaded(mapSource) && !map.isMoving())
      resolve();
    else map.once("idle", () => resolve());
  });

/**
 * What the feature resolver (apps/server/README.md#feature-resolver) knows of a key: its kind,
 * where it is, and for an OSM feature without an ID the key the tiles find it by (a path's first way).
 */
interface Resolved {
  kind: FeatureKind;
  bbox: BBox | null;
  key?: string;
}

async function resolve(key: string): Promise<Resolved | undefined> {
  if (!transitApi) return undefined;
  try {
    const r = await fetch(`${transitApi}features/${encodeURIComponent(key)}`);
    return r.ok ? ((await r.json()) as Resolved) : undefined;
  } catch {
    return undefined;
  }
}

export const CyclingMap: React.FC = () => {
  const map = useMap();
  const { theme } = useTheme();
  const styleGeneration = useStyleGeneration();
  // The cycling layer is derived from OpenStreetMap by pipelines/build-cycling.ts (packages/cycling-core).
  useDatasets(["osm", "transitopia"]);
  const [show, setShow] = useCyclingShow();
  const showRef = React.useRef(show);
  showRef.current = show;
  const tiles = useCyclingTiles();

  // Add the tiles and the cycling layers to the map, again after a theme switch replaces the style:
  React.useEffect(() => {
    if (!map || !tiles) return;
    if (!map.getSource(mapSource))
      map.addSource(mapSource, { type: "vector", url: tiles });
    const layers = cyclingLayers(theme, showRef.current);
    for (const layer of layers) {
      if (!map.getLayer(layer.id)) map.addLayer(layer);
    }
    return () => {
      try {
        for (const layer of layers) {
          if (map.getLayer(layer.id)) {
            map.removeLayer(layer.id);
          }
        }
      } catch {
        console.error(
          "Unable to remove cycling layers. Perhaps map was already destroyed. This can happen in dev with hot reloading.",
        );
      }
    };
  }, [map, theme, styleGeneration, tiles]);

  // What the layers panel shows: filter the layers in place.
  React.useEffect(() => {
    if (!map) return;
    for (const [id, filter] of Object.entries(cyclingFilters(show)))
      if (map.getLayer(id)) map.setFilter(id, filter);
  }, [map, show]);

  // The selection is the URL's ?select=; `found` is what the map knows of that key.
  const [searchParams] = useSearchParams();
  const key = selectKey(searchParams);
  const [found, setFound] = React.useState<Found>();
  const [, navigate] = useLocation();
  useOtherModeRedirect("cycling");
  const current = found?.key === key ? found : undefined;
  const routeId = React.useMemo(() => {
    const ref = key ? osmRef(key) : undefined;
    return ref?.scheme === "osm-relation" ? ref.value : undefined;
  }, [key]);
  const selectedElement =
    current?.kind === "element" ? current.element : undefined;
  const routes = useCyclingRoutes(
    !!routeId
      || (selectedElement?.type === "cycling_way" && !!selectedElement.routes),
  );
  const route = routeId ? routes?.[routeId] : undefined;
  const notFound =
    current?.kind === "notFound" || (routeId && routes && !route) ?
      key
    : undefined;
  // Select something (or nothing), with what the map knows of it, so it isn't looked up again.
  const select = React.useCallback((f: Found | undefined) => {
    if (f) setFound(f);
    writeSelect(f?.key);
  }, []);
  // The key a link without a map position opened with: the map goes to it once found.
  const linked = React.useRef(openedWithPosition ? undefined : key);

  // A path or bike parking the map doesn't know yet (from a link, or the URL edited): in the tiles
  // where the map is, else as the resolver says. The tiles know a path only by its first way; the
  // resolver knows it by any of them, and gives the first (written back to the URL).
  const lookUp = key && !routeId && !current ? key : undefined;
  React.useEffect(() => {
    if (!map || !tiles || !lookUp) return;
    const ref = osmRef(lookUp);
    let cancelled = false;
    void (async () => {
      await whenIdle(map);
      let key = lookUp;
      let moved = false;
      let found = ref && findLoaded(map, ref);
      if (!found && !cancelled) {
        const f = await resolve(lookUp);
        if (cancelled) return;
        if (f && modeOfKind(f.kind) === "transit") {
          navigate(modeUrl("transit", lookUp), { replace: true });
          return;
        }
        const target = f?.key ? osmRef(f.key) : ref;
        if (target) {
          if (f?.key) key = f.key;
          found = findLoaded(map, target);
          if (!found && f?.bbox) {
            showBounds(map, f.bbox, false);
            moved = true;
            await whenIdle(map);
            found = findLoaded(map, target);
          }
        }
      }
      if (cancelled) return;
      const goTo = linked.current === lookUp;
      linked.current = undefined;
      if (!found) {
        setFound({ kind: "notFound", key: lookUp });
        return;
      }
      // Found in the default view of a link without a map position: go to it.
      if (goTo && !moved)
        map.jumpTo({ center: found.at, zoom: Math.max(map.getZoom(), 16) });
      select({ kind: "element", key, ...found });
    })();
    return () => {
      cancelled = true;
    };
  }, [map, tiles, lookUp, navigate, select]);

  // A bike route from a link without a map position is shown whole.
  React.useEffect(() => {
    if (!map || !route || linked.current !== key) return;
    linked.current = undefined;
    if (route.bbox) showBounds(map, route.bbox, false);
  }, [map, route, key]);

  // The selected route's paths are highlighted (cycling-map-layers.ts), again after a theme switch.
  const selectedRoute = route ? routeId : undefined;
  React.useEffect(() => {
    map?.setGlobalStateProperty(SELECTED_ROUTE, selectedRoute ?? null);
  }, [map, selectedRoute, styleGeneration]);

  const hoveredFeatureIdRef = React.useRef<string | undefined>(undefined);

  const handleMouseOver = React.useCallback(
    (e: MapLibreGL.MapLayerEventType["mousemove"]) => {
      if (!map) return undefined;
      if (map.getZoom() < 13) return;
      const feature = e.features![0];
      if (feature.id !== hoveredFeatureIdRef.current) {
        if (hoveredFeatureIdRef.current) {
          map.removeFeatureState(
            {
              source: mapSource,
              sourceLayer: CYCLING_LAYER,
              id: hoveredFeatureIdRef.current,
            },
            "hover",
          );
        }
        hoveredFeatureIdRef.current = feature.id as string;
        map.setFeatureState(
          {
            source: mapSource,
            sourceLayer: CYCLING_LAYER,
            id: feature.id,
          },
          { hover: true },
        );
        map.getCanvas().style.cursor = "pointer";
      }
    },
    [map],
  );

  const handleMouseOut = React.useCallback(() => {
    if (!map) return undefined;
    if (hoveredFeatureIdRef.current) {
      map.removeFeatureState(
        {
          source: mapSource,
          sourceLayer: CYCLING_LAYER,
          id: hoveredFeatureIdRef.current,
        },
        "hover",
      );
      hoveredFeatureIdRef.current = undefined;
    }
    map.getCanvas().style.cursor = "default";
  }, [map]);

  React.useEffect(() => {
    // When leaving the cycling map, clean up the hover state:
    return () => {
      if (!map) return;
      if (hoveredFeatureIdRef.current) {
        map.removeFeatureState(
          {
            source: mapSource,
            sourceLayer: CYCLING_LAYER,
            id: hoveredFeatureIdRef.current,
          },
          "hover",
        );
      }
    };
  }, [map]);

  useMapLayerEvent(
    "mousemove",
    handleMouseOver,
    ...pathLayerIds,
    ...otherLayerIds,
  );
  useMapLayerEvent(
    "mouseleave",
    handleMouseOut,
    ...pathLayerIds,
    ...otherLayerIds,
  );

  const handleClick = React.useCallback(
    (e: MapLibreGL.MapLayerEventType["click"]) => {
      const feature = e.features?.[0];
      if (!map || map.getZoom() < 13 || !feature) return;
      const element = asElement(feature);
      select({
        kind: "element",
        key: keyOfElement(element),
        element,
        at: [e.lngLat.lng, e.lngLat.lat],
      });
    },
    [map, select],
  );

  useMapLayerEvent("click", handleClick, ...pathLayerIds, ...otherLayerIds);

  const selectedId = selectedElement?.id;
  React.useEffect(() => {
    if (!map || selectedId === undefined) return;
    map.setFeatureState(
      { source: mapSource, sourceLayer: CYCLING_LAYER, id: selectedId },
      { selected: true },
    );
    return () => {
      map.removeFeatureState(
        { source: mapSource, sourceLayer: CYCLING_LAYER, id: selectedId },
        "selected",
      );
    };
  }, [map, selectedId]);

  const closeInfobox = React.useCallback(() => select(undefined), [select]);
  const at = current?.kind === "element" ? current.at : undefined;
  const centre = React.useCallback(() => {
    if (map && at)
      map.easeTo({ center: at, zoom: Math.max(map.getZoom(), 15) });
  }, [map, at]);

  const from = current?.kind === "route" ? current.from : undefined;
  return (
    <>
      <CyclingLayers show={show} onChange={setShow} />
      {notFound ?
        <MapOverlayWindow className="top-5 sm:top-24">
          <div role="alert" className="flex items-start gap-2">
            <span className="flex-1">
              Couldn't find {notFound} on the cycling map here.
            </span>
            <button type="button" className="underline" onClick={closeInfobox}>
              Dismiss
            </button>
          </div>
        </MapOverlayWindow>
      : null}
      {routeId && route ?
        <CyclingRouteCard
          id={routeId}
          route={route}
          onShowAll={
            map && route.bbox ?
              () => showBounds(map, route.bbox!, true)
            : undefined
          }
          back={
            from ?
              {
                label:
                  from.element.type === "cycling_way" ?
                    pathTitle(from.element)
                  : (from.element.name ?? "Bike parking"),
                onBack: () => select(from),
              }
            : undefined
          }
          onClose={closeInfobox}
        />
      : current?.kind === "element" && selectedElement?.type === "cycling_way" ?
        <BikePathCard
          feature={selectedElement}
          routes={routes}
          onRoute={(id) =>
            select({ kind: "route", key: `osm-relation:${id}`, from: current })
          }
          onCentre={centre}
          onClose={closeInfobox}
        />
      : selectedElement?.type === "bicycle_parking" ?
        <BikeParkingCard
          feature={selectedElement}
          onCentre={centre}
          onClose={closeInfobox}
        />
      : null}
    </>
  );
};
