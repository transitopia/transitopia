import React from "react";
import type * as MapLibreGL from "maplibre-gl";

import { useLocation, useSearchParams } from "wouter";

import {
  cyclingFilters,
  cyclingLayers,
  mapSource,
  otherLayerIds,
  pathLayerIds,
  ROUTE_HIGHLIGHT_LAYER,
  routeHighlightFilter,
  routeHighlightLayer,
  routeHighlightLayout,
  routesSource,
  routesSourceSpec,
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
  CYCLING_MIN_ZOOM,
} from "@transitopia/cycling-core/tiles.ts";
import type { BBox } from "@transitopia/cycling-core/routes.ts";
import { modeOfKind, type FeatureKind } from "@transitopia/shared/features.ts";
import { useTheme } from "../Theme/Theme.tsx";
import { useDatasets } from "../Attribution/Attribution.tsx";
import { MapOverlayWindow } from "../Map/MapOverlayWindow.tsx";
import { modeUrl, useOtherModeRedirect } from "../components/ModeLink.tsx";
import { transitApi } from "../config.ts";
import { openedWithPosition } from "../startup.ts";
import { BikeParkingCard } from "./BikeParkingCard.tsx";
import { BikePathCard, pathRoutes, pathTitle } from "./BikePathCard.tsx";
import { API_UNREACHABLE, CyclingRouteCard } from "./CyclingRouteCard.tsx";
import { CyclingLayers, useCyclingShow } from "./CyclingLayers.tsx";
import {
  useCyclingRoute,
  useCyclingRoutes,
  useCyclingTiles,
} from "./cycling-data.ts";
import {
  asElement,
  findLoaded,
  isRouteKey,
  keyOfElement,
  osmRef,
  selectKey,
  writeSelect,
  type CyclingElement,
} from "./cycling-select.ts";
import { useCardTrail } from "../components/useCardTrail.ts";

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
 * selection: the path or bike parking it names, a bike route (read from the API server), or that it
 * couldn't be found. Kept while the URL names that key.
 */
type Found =
  | FoundElement
  | { kind: "route"; key: string }
  | { kind: "notFound"; key: string };

/** The title of a path's or bike parking's card, for the back strip of a card opened from it. */
const elementTitle = (e: CyclingElement) =>
  e.type === "cycling_way" ? pathTitle(e) : (e.name ?? "Bike parking");

const PADDING = { top: 90, bottom: 150, left: 20, right: 50 };

/** Room around what's shown: on phones the card is a bottom sheet up to 60% of the screen tall. */
const padding = () =>
  matchMedia("(max-width: 639px)").matches ?
    { ...PADDING, bottom: Math.round(innerHeight * 0.6) + 20 }
  : PADDING;

/**
 * Move the map to show bounds, zoomed in at least to `minZoom`: for a path, as far as paths can be
 * selected; a bike route is highlighted at any zoom.
 */
function showBounds(
  map: MapType,
  b: BBox,
  animate: boolean,
  minZoom = CYCLING_DETAIL_ZOOM,
): void {
  const camera = map.cameraForBounds(
    [
      [b[0], b[1]],
      [b[2], b[3]],
    ],
    { padding: padding(), maxZoom: 17 },
  );
  if (!camera) return;
  const to = {
    ...camera,
    zoom: Math.max(camera.zoom ?? minZoom, minZoom),
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
  const [layersShown, setShow] = useCyclingShow();
  const showRef = React.useRef(layersShown);
  showRef.current = layersShown;
  const tiles = useCyclingTiles();
  // The selected bike route's relation, for the highlight layer when it's (re-)added.
  const highlightRef = React.useRef<number>(undefined);

  // Add the tiles and the cycling layers to the map, again after a theme switch replaces the style:
  React.useEffect(() => {
    if (!map || !tiles) return;
    if (!map.getSource(mapSource))
      map.addSource(mapSource, { type: "vector", url: tiles });
    if (!map.getSource(routesSource))
      map.addSource(routesSource, routesSourceSpec(tiles));
    const layers = [
      // Under the paths.
      routeHighlightLayer(highlightRef.current),
      ...cyclingLayers(theme, showRef.current),
    ];
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
    for (const [id, filter] of Object.entries(cyclingFilters(layersShown)))
      if (map.getLayer(id)) map.setFilter(id, filter);
  }, [map, layersShown]);

  // The selection is the URL's ?select=; `found` is what the map knows of that key.
  const [searchParams] = useSearchParams();
  const key = selectKey(searchParams);
  const [found, setFound] = React.useState<Found>();
  const [, navigate] = useLocation();
  useOtherModeRedirect("cycling");
  const current = found?.key === key ? found : undefined;
  const routeKey = key && isRouteKey(key) ? key : undefined;
  const routeState = useCyclingRoute(routeKey);
  const route = routeState?.state === "found" ? routeState.route : undefined;
  const selectedElement =
    current?.kind === "element" ? current.element : undefined;
  const pathRouteKeys = React.useMemo(
    () =>
      selectedElement?.type === "cycling_way" ?
        pathRoutes(selectedElement).map((id) => `osm-relation:${id}`)
      : [],
    [selectedElement],
  );
  const pathRouteStates = useCyclingRoutes(pathRouteKeys);
  const notFound =
    current?.kind === "notFound" || routeState?.state === "notFound" ?
      key
    : undefined;
  const unreachable = routeState?.state === "unreachable";
  // The key a link without a map position opened with: the map goes to it once found.
  const linked = React.useRef(openedWithPosition ? undefined : key);
  // The cards this one was opened through (apps/web/README.md#cross-references).
  const trail = useCardTrail<Found>();
  // Select something (or nothing), with what the map knows of it, so it isn't looked up again.
  const show = React.useCallback((f: Found | undefined) => {
    if (f) setFound(f);
    writeSelect(f?.key);
  }, []);
  // A selection from the map or a link, not a card: the back strip forgets the cards before.
  const select = React.useCallback(
    (f: Found | undefined) => {
      trail.clear();
      show(f);
    },
    [trail, show],
  );
  // The showing card opens another, so the new card's back strip returns here.
  const title =
    route?.name ?? (selectedElement && elementTitle(selectedElement));
  const open = (f: Found) => {
    const here =
      current
      ?? (routeKey ? { kind: "route" as const, key: routeKey } : undefined);
    if (here && title) trail.push(here, title);
    show(f);
  };
  const back = () => {
    const prev = trail.pop();
    if (prev) show(prev);
  };
  // A route's ref in the URL becomes its ID, once the server has named it (a link keeps going to it).
  React.useEffect(() => {
    if (!route || !routeKey || route.key === routeKey) return;
    if (linked.current === routeKey) linked.current = route.key;
    writeSelect(route.key);
  }, [route, routeKey]);

  // A path or bike parking the map doesn't know yet (from a link, or the URL edited): in the tiles
  // where the map is, else as the resolver says. The tiles know a path only by its first way; the
  // resolver knows it by any of them, and gives the first (written back to the URL).
  const lookUp = key && !routeKey && !current ? key : undefined;
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
    if (!map || !route || !routeKey || linked.current !== routeKey) return;
    linked.current = undefined;
    if (route.bbox) showBounds(map, route.bbox, false, CYCLING_MIN_ZOOM);
  }, [map, route, routeKey]);

  // The selected route is highlighted whole (cycling-map-layers.ts), again after a theme switch.
  const highlight = route?.osmRelation;
  highlightRef.current = highlight;
  React.useEffect(() => {
    if (!map?.getLayer(ROUTE_HIGHLIGHT_LAYER)) return;
    map.setFilter(ROUTE_HIGHLIGHT_LAYER, routeHighlightFilter(highlight));
    map.setLayoutProperty(
      ROUTE_HIGHLIGHT_LAYER,
      "visibility",
      routeHighlightLayout(highlight).visibility,
    );
  }, [map, highlight, styleGeneration, tiles]);

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

  const backStrip =
    trail.backLabel ? { label: trail.backLabel, onBack: back } : undefined;
  const openRoute = (r: { key: string }) => open({ kind: "route", key: r.key });
  return (
    <>
      <CyclingLayers show={layersShown} onChange={setShow} />
      {unreachable ?
        <MapOverlayWindow className="top-5 sm:top-24">
          <div role="alert" className="flex items-start gap-2">
            <span className="flex-1">{API_UNREACHABLE}</span>
            <button type="button" className="underline" onClick={closeInfobox}>
              Dismiss
            </button>
          </div>
        </MapOverlayWindow>
      : null}
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
      {routeKey && route ?
        <CyclingRouteCard
          route={route}
          onRoute={openRoute}
          onShowAll={
            map && route.bbox ?
              () => showBounds(map, route.bbox!, true, CYCLING_MIN_ZOOM)
            : undefined
          }
          back={backStrip}
          onClose={closeInfobox}
        />
      : current?.kind === "element" && selectedElement?.type === "cycling_way" ?
        <BikePathCard
          feature={selectedElement}
          routes={pathRouteStates}
          onRoute={openRoute}
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
