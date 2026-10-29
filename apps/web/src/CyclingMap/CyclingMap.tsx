import React from "react";
import type * as MapLibreGL from "maplibre-gl";

import { useLocation } from "wouter";

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
import { BikeRouteCard, pathTitle } from "./BikeRouteCard.tsx";
import { CyclingRouteCard } from "./CyclingRouteCard.tsx";
import { CyclingLayers, useCyclingShow } from "./CyclingLayers.tsx";
import { useCyclingRoutes, useCyclingTiles } from "./cycling-data.ts";
import {
  asElement,
  findLoaded,
  keyOfElement,
  osmRef,
  readSelect,
  writeSelect,
  type CyclingElement,
} from "./cycling-select.ts";

/** What's selected, and its key in ?select= (apps/web/README.md#cycling-links). */
type Selection =
  | {
      kind: "element";
      key: string;
      element: CyclingElement;
      /** A point on it, for "Centre on map". */
      at: [number, number];
    }
  | {
      kind: "route";
      key: string;
      /** The OSM relation id. */
      id: string;
      /** The path card it was opened from. */
      from?: Selection | undefined;
    };

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

/** Where the feature resolver (apps/server/README.md#feature-resolver) says a key is, if it knows. */
async function resolve(
  key: string,
): Promise<{ kind: FeatureKind; bbox: BBox | null } | undefined> {
  if (!transitApi) return undefined;
  try {
    const r = await fetch(`${transitApi}features/${encodeURIComponent(key)}`);
    return r.ok ?
        ((await r.json()) as { kind: FeatureKind; bbox: BBox | null })
      : undefined;
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

  const [selected, setSelected] = React.useState<Selection>();
  // A key from the URL, until it's found (or not).
  const [pending, setPending] = React.useState(readSelect);
  const [notFound, setNotFound] = React.useState<string>();
  const [, navigate] = useLocation();
  useOtherModeRedirect("cycling");
  const pendingRef = React.useMemo(
    () => (pending ? osmRef(pending) : undefined),
    [pending],
  );
  const selectedElement =
    selected?.kind === "element" ? selected.element : undefined;
  const routes = useCyclingRoutes(
    pendingRef?.scheme === "osm-relation"
      || selected?.kind === "route"
      || (selectedElement?.type === "cycling_way" && !!selectedElement.routes),
  );
  const select = React.useCallback((s: Selection | undefined) => {
    setPending(undefined);
    setNotFound(undefined);
    setSelected(s);
  }, []);

  // A path or bike parking from the URL: in the tiles where the map is, else where the resolver
  // says it is.
  React.useEffect(() => {
    if (!map || !tiles || !pending) return;
    const ref = osmRef(pending);
    if (ref?.scheme === "osm-relation") return; // from the bike routes, below
    let cancelled = false;
    void (async () => {
      await whenIdle(map);
      let found = ref && findLoaded(map, ref);
      // Found in the default view of a link without a map position: go to it.
      if (found && !openedWithPosition)
        map.jumpTo({ center: found.at, zoom: Math.max(map.getZoom(), 16) });
      if (!found && !cancelled) {
        const f = await resolve(pending);
        if (cancelled) return;
        if (f && modeOfKind(f.kind) === "transit") {
          navigate(modeUrl("transit", pending), { replace: true });
          return;
        }
        if (ref && f?.bbox) {
          showBounds(map, f.bbox, false);
          await whenIdle(map);
          found = findLoaded(map, ref);
        }
      }
      if (cancelled) return;
      if (found) select({ kind: "element", key: pending, ...found });
      else {
        setPending(undefined);
        setNotFound(pending);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [map, tiles, pending, navigate, select]);

  // A bike route from the URL: in the bike routes, shown whole if the link has no map position.
  React.useEffect(() => {
    if (!map || !routes || pendingRef?.scheme !== "osm-relation") return;
    const r = routes[pendingRef.value];
    if (!r) {
      setPending(undefined);
      setNotFound(pending);
      return;
    }
    select({ kind: "route", key: pending!, id: pendingRef.value });
    if (!openedWithPosition && r.bbox) showBounds(map, r.bbox, false);
  }, [map, routes, pending, pendingRef, select]);

  // The selection (or the key that wasn't found) in the URL.
  React.useEffect(() => {
    if (!pending) writeSelect(selected?.key ?? notFound);
  }, [pending, selected, notFound]);

  // The selected route's paths are highlighted (cycling-map-layers.ts), again after a theme switch.
  const selectedRoute = selected?.kind === "route" ? selected.id : undefined;
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
  const at = selected?.kind === "element" ? selected.at : undefined;
  const centre = React.useCallback(() => {
    if (map && at)
      map.easeTo({ center: at, zoom: Math.max(map.getZoom(), 15) });
  }, [map, at]);

  const route = selected?.kind === "route" ? routes?.[selected.id] : undefined;
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
      {selected?.kind === "route" && route ?
        <CyclingRouteCard
          id={selected.id}
          route={route}
          onShowAll={
            map && route.bbox ?
              () => showBounds(map, route.bbox!, true)
            : undefined
          }
          back={
            selected.from?.kind === "element" ?
              {
                label:
                  selected.from.element.type === "cycling_way" ?
                    pathTitle(selected.from.element)
                  : (selected.from.element.name ?? "Bike parking"),
                onBack: () => select(selected.from),
              }
            : undefined
          }
          onClose={closeInfobox}
        />
      : selectedElement?.type === "cycling_way" ?
        <BikeRouteCard
          feature={selectedElement}
          routes={routes}
          onRoute={(id) =>
            select({
              kind: "route",
              key: `osm-relation:${id}`,
              id,
              from: selected,
            })
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
