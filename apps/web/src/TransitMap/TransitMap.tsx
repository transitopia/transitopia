import React from "react";
import {
  TransitEngine,
  type TransitSnapshot,
} from "@transitopia/transit-map/engine.ts";
import {
  applyBrandColors,
  overviewLayers,
  overviewMaxZoom,
} from "@transitopia/transit-map/overview.ts";
import { ENGINE_MIN_ZOOM } from "@transitopia/shared/transit-overview.ts";
import {
  modeOfKind,
  parseKey,
  type FeatureKind,
} from "@transitopia/shared/features.ts";
import { useLocation } from "wouter";

import { transitApi, transitData, transitOverviewTiles } from "../config.ts";
import { openedPath, openedWithPosition } from "../startup.ts";
import { useMap, useStyleGeneration, type MapType } from "../Map/MapUtils.ts";
import { MapOverlayWindow } from "../Map/MapOverlayWindow.tsx";
import { modeUrl, useOtherModeRedirect } from "../components/ModeLink.tsx";
import { useTheme } from "../Theme/Theme.tsx";
import { useDatasets } from "../Attribution/Attribution.tsx";
import { TimeBar } from "./TimeBar.tsx";
import { OverviewLayers, TransitLayers } from "./TransitLayers.tsx";
import { VehicleCard } from "./VehicleCard.tsx";
import { PlaceCard } from "./PlaceCard.tsx";
import { PickMenu } from "./PickMenu.tsx";
import { RouteCard } from "./RouteCard.tsx";
import { FollowPill } from "./FollowPill.tsx";
import { useOverlayPadding } from "./overlayPadding.ts";
import { FEEDS } from "./feeds.ts";
import { VIEWS, lngLatBounds } from "./views.ts";

const PADDING = { top: 90, bottom: 150, left: 20, right: 50 };

/**
 * Move the map to bounds, zoomed in at least as far as the engine starts (on a phone, a view's
 * bounds fit only further out).
 */
function showBounds(
  map: MapType,
  bounds: [[number, number], [number, number]],
  opts: { animate?: boolean; maxZoom?: number } = {},
): void {
  const camera = map.cameraForBounds(bounds, {
    padding: PADDING,
    ...(opts.maxZoom === undefined ? {} : { maxZoom: opts.maxZoom }),
  });
  if (!camera) return;
  const to = {
    ...camera,
    zoom: Math.max(camera.zoom ?? ENGINE_MIN_ZOOM, ENGINE_MIN_ZOOM),
  };
  if (opts.animate === false) map.jumpTo(to);
  else map.flyTo(to);
}

/**
 * Show the first named view (views.ts) when the site was opened on /transit (or /) without a map
 * position. Only once: switching modes later keeps wherever the map is.
 */
let initialViewDone = false;
function useInitialView(map: MapType | undefined): void {
  React.useEffect(() => {
    if (!map || initialViewDone) return;
    initialViewDone = true;
    const openedOnTransit =
      openedPath === "/" || openedPath.startsWith("/transit");
    if (openedOnTransit && !openedWithPosition)
      showBounds(map, lngLatBounds(VIEWS[0]!.bounds), {
        animate: false,
      });
  }, [map]);
}

/** Whether the map is zoomed in far enough for the engine (ENGINE_MIN_ZOOM); further out, the overview shows. */
function useEngineZoom(map: MapType | undefined): boolean {
  const [active, setActive] = React.useState(false);
  React.useEffect(() => {
    if (!map) return;
    const update = () => setActive(map.getZoom() >= ENGINE_MIN_ZOOM);
    update();
    map.on("zoomend", update);
    return () => {
      map.off("zoomend", update);
    };
  }, [map]);
  return active;
}

/** The transit overview tileset's source (packages/transit-map/src/overview.ts), only on /transit. */
const OVERVIEW_SOURCE = "transitopia-transit-overview";

/** What the overview draws: every feed. */
const OVERVIEW_DATASETS = [...new Set(FEEDS.map((f) => f.feed.dataset))];

/**
 * Every feed's routes zoomed out (packages/transit-core/DESIGN.md#overview-tiles), below the zoom
 * the engine starts at, and further in until the engine draws the lines in view (so zooming in
 * never leaves the map without any); again after a theme switch replaces the style.
 */
function useOverview(
  map: MapType | undefined,
  theme: "light" | "dark",
  engine: TransitEngine | undefined,
): void {
  const styleGeneration = useStyleGeneration();
  const engineLines = React.useSyncExternalStore(
    React.useCallback(
      (fn: () => void) => engine?.subscribe(fn) ?? (() => {}),
      [engine],
    ),
    () => engine?.getSnapshot().linesReady ?? false,
  );
  const [zoomedOut, setZoomedOut] = React.useState(false);
  // Credit every feed while it's drawn.
  useDatasets(zoomedOut || !engineLines ? OVERVIEW_DATASETS : []);
  React.useEffect(() => {
    if (!map) return;
    const update = () => setZoomedOut(map.getZoom() < ENGINE_MIN_ZOOM);
    update();
    map.on("zoomend", update);
    return () => {
      map.off("zoomend", update);
    };
  }, [map]);
  const maxzoom = overviewMaxZoom(engineLines);
  const maxzoomRef = React.useRef(maxzoom);
  maxzoomRef.current = maxzoom;
  // Only /transit loads the tileset: its source comes and goes with its layers.
  React.useEffect(() => {
    if (!map) return;
    if (!map.getSource(OVERVIEW_SOURCE))
      map.addSource(OVERVIEW_SOURCE, {
        type: "vector",
        url: transitOverviewTiles,
      });
    // Brand colours or frequency only, as the viewer chose (an engine sets it too, when it changes).
    applyBrandColors(map);
    const layers = overviewLayers(OVERVIEW_SOURCE, theme, maxzoomRef.current);
    for (const layer of layers)
      if (!map.getLayer(layer.id)) map.addLayer(layer);
    return () => {
      for (const layer of layers)
        if (map.getLayer(layer.id)) map.removeLayer(layer.id);
      if (map.getSource(OVERVIEW_SOURCE)) map.removeSource(OVERVIEW_SOURCE);
    };
  }, [map, theme, styleGeneration]);
  React.useEffect(() => {
    if (!map) return;
    for (const layer of overviewLayers(OVERVIEW_SOURCE, theme))
      if (map.getLayer(layer.id)) map.setLayerZoomRange(layer.id, 0, maxzoom);
  }, [map, theme, styleGeneration, maxzoom]);
}

/**
 * /transit (apps/web/README.md#transit-mode): mounts the transit engine on the shared map and renders its
 * controls. The engine draws every frame on its own; React only sees its snapshot store. One engine
 * shows every feed, loading each while it's in view (packages/transit-map/README.md#feeds); zoomed
 * out, it's hidden and paused (not disposed), so zooming back in shows it at once.
 */
export default function TransitMap() {
  const map = useMap();
  const { theme } = useTheme();
  const themeRef = React.useRef(theme);
  const [engine, setEngine] = React.useState<TransitEngine>();
  const [error, setError] = React.useState<string>();
  // Bumped when the published data is rebuilt under an engine: the engine is made again.
  const [build, setBuild] = React.useState(0);
  useInitialView(map);
  useOtherModeRedirect("transit");
  const shown = useEngineZoom(map);
  const inCoverage = React.useSyncExternalStore(
    React.useCallback(
      (fn: () => void) => engine?.subscribe(fn) ?? (() => {}),
      [engine],
    ),
    () => engine?.getSnapshot().inCoverage ?? true,
  );
  useOverview(map, theme, shown ? engine : undefined);

  React.useEffect(() => {
    if (!map) return;
    let cancelled = false;
    let created: TransitEngine | undefined;
    const params = new URLSearchParams(location.search);
    setError(undefined);
    TransitEngine.create(map, {
      dataBase: transitData,
      apiBase: transitApi,
      theme: themeRef.current,
      scenario: params.get("scenario") ?? undefined,
      debug: params.has("debug"),
      feeds: FEEDS,
      onRebuilt: () => setBuild((b) => b + 1),
    }).then(
      (eng) => {
        if (cancelled) {
          eng.dispose();
          return;
        }
        created = eng;
        setEngine(eng);
        Object.assign(window, { transit: eng.debugHandle() });
      },
      (e: unknown) => {
        console.error(e);
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      },
    );
    return () => {
      cancelled = true;
      created?.dispose();
      setEngine(undefined);
      delete (window as { transit?: unknown }).transit;
    };
  }, [map, build]);

  React.useEffect(() => {
    engine?.setVisible(shown);
  }, [engine, shown]);

  // Runs before the map swaps its style (child effects run first), so the engine re-adds its
  // layers in the new theme's colours when the new style loads.
  React.useEffect(() => {
    themeRef.current = theme;
    engine?.setTheme(theme);
  }, [engine, theme]);

  return (
    <>
      {error && shown ?
        <MapOverlayWindow className="top-5 sm:top-24 text-red-700 dark:text-red-300">
          <div role="alert">{error}</div>
        </MapOverlayWindow>
      : null}
      {!inCoverage ?
        <MapOverlayWindow className="top-5 sm:top-24">
          Transit data isn't available here yet. Go to{" "}
          {VIEWS.map((v, i) => (
            <React.Fragment key={v.name}>
              {i === 0 ?
                ""
              : i === VIEWS.length - 1 ?
                " or "
              : ", "}
              <button
                type="button"
                className="underline"
                onClick={() => map && showBounds(map, lngLatBounds(v.bounds))}>
                {v.name}
              </button>
            </React.Fragment>
          ))}
          .
        </MapOverlayWindow>
      : null}
      {engine && shown ?
        <EngineControls
          engine={engine}
          onElsewhere={(bounds) => {
            // The engine selects it once a feed loaded there has it. A feature a loaded feed's
            // plan doesn't have (a stop no drawn route serves) can't be selected: the map just
            // shows where it is.
            if (map) showBounds(map, lngLatBounds(bounds), { maxZoom: 16 });
          }}
        />
      : null}
      {map && !shown ?
        <OverviewLayers map={map} engine={engine} inView={inCoverage} />
      : null}
    </>
  );
}

const EngineControls: React.FC<{
  engine: TransitEngine;
  /** A selected feature is elsewhere: move the map there (the engine selects it once it can). */
  onElsewhere: (bounds: [number, number, number, number]) => void;
}> = ({ engine, onElsewhere }) => {
  const snap: TransitSnapshot = React.useSyncExternalStore(
    engine.subscribe,
    engine.getSnapshot,
  );
  useDatasets(snap.datasets);
  useElsewhere(snap.elsewhere, onElsewhere);
  useOverlayPadding(engine);
  return (
    <>
      <FollowPill engine={engine} snap={snap} />
      <TransitLayers engine={engine} snap={snap} />
      <VehicleCard engine={engine} snap={snap} />
      <PlaceCard engine={engine} snap={snap} />
      <RouteCard engine={engine} snap={snap} />
      <PickMenu engine={engine} snap={snap} />
      <TimeBar
        engine={engine}
        snap={snap}
        cardOpen={!!snap.selected || !!snap.place}
      />
    </>
  );
};

/**
 * A `?select=` key no loaded feed has: ask the feature resolver where it is
 * (apps/server/README.md#feature-resolver), so the map can move there. An OSM ref that no transit
 * feature has goes to /cycling.
 */
function useElsewhere(
  key: string | undefined,
  onFound: (bounds: [number, number, number, number]) => void,
): void {
  const found = React.useRef(onFound);
  found.current = onFound;
  const [, navigate] = useLocation();
  React.useEffect(() => {
    if (!key) return;
    const k = parseKey(key);
    const osm = k?.form === "ref" && k.scheme.startsWith("osm-");
    const toCycling = () =>
      navigate(modeUrl("cycling", key), { replace: true });
    if (!transitApi) {
      if (osm) toCycling();
      return;
    }
    let cancelled = false;
    fetch(`${transitApi}features/${encodeURIComponent(key)}`)
      .then((r) =>
        r.ok || r.status === 404 ?
          (r.json() as Promise<{
            kind?: FeatureKind;
            bbox?: [number, number, number, number] | null;
          }>)
        : null,
      )
      .then((f) => {
        if (cancelled || !f) return;
        if (f.kind ? modeOfKind(f.kind) === "cycling" : osm) toCycling();
        else if (f.bbox) found.current(f.bbox);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [key, navigate]);
}
