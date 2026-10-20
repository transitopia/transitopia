import React from "react";
import {
  TransitEngine,
  type TransitSnapshot,
} from "@transitopia/transit-map/engine.ts";
import { readUrl } from "@transitopia/transit-map/url.ts";
import {
  overviewLayers,
  overviewMaxZoom,
} from "@transitopia/transit-map/overview.ts";
import { ENGINE_MIN_ZOOM } from "@transitopia/shared/transit-overview.ts";

import { transitApi, transitData } from "../config.ts";
import { openedPath, openedWithPosition } from "../startup.ts";
import {
  OVERVIEW_SOURCE,
  useMap,
  useStyleGeneration,
  type MapType,
} from "../Map/MapUtils.ts";
import { MapOverlayWindow } from "../Map/MapOverlayWindow.tsx";
import { useTheme } from "../Theme/Theme.tsx";
import { useDatasets } from "../Attribution/Attribution.tsx";
import { TimeBar } from "./TimeBar.tsx";
import { TransitLayers } from "./TransitLayers.tsx";
import { VehicleCard } from "./VehicleCard.tsx";
import { PlaceCard } from "./PlaceCard.tsx";
import { PickMenu } from "./PickMenu.tsx";
import { RouteCard } from "./RouteCard.tsx";
import { FollowPill } from "./FollowPill.tsx";
import { useOverlayPadding } from "./overlayPadding.ts";
import {
  DEFAULT_REGION,
  REGIONS,
  lngLatBounds,
  regionInView,
  type SiteRegion,
} from "./regions.ts";

const PADDING = { top: 90, bottom: 150, left: 20, right: 50 };

/**
 * Move the map to bounds, zoomed in at least as far as a region's engine starts (on a phone, a
 * region's first view fits only further out).
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
 * Show the default region's network when the site was opened on /transit (or /) without a map
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
      showBounds(map, lngLatBounds(DEFAULT_REGION.info.initialBounds), {
        animate: false,
      });
  }, [map]);
}

function viewOf(map: MapType): SiteRegion | undefined {
  const b = map.getBounds();
  return regionInView({
    west: b.getWest(),
    south: b.getSouth(),
    east: b.getEast(),
    north: b.getNorth(),
  });
}

interface RegionState {
  region: SiteRegion;
  /** Whether any region is in view. */
  inView: boolean;
  /** Whether its engine runs: it's in view, zoomed in to ENGINE_MIN_ZOOM or further. */
  active: boolean;
  /** Whether the map has been looked at yet (until then `region` is only the default). */
  ready: boolean;
}

/**
 * The region the engine shows (docs/DESIGN.md#regions-and-feeds): the one in view, or while the
 * view is outside every region, the last one shown (at first, the default). Its engine runs only
 * zoomed in to ENGINE_MIN_ZOOM; further out, the overview shows every region.
 */
function useRegion(map: MapType | undefined): RegionState {
  const [state, setState] = React.useState<RegionState>({
    region: DEFAULT_REGION,
    inView: true,
    active: false,
    ready: false,
  });
  React.useEffect(() => {
    if (!map) return;
    const update = () => {
      const r = viewOf(map);
      const active = r !== undefined && map.getZoom() >= ENGINE_MIN_ZOOM;
      setState((prev) => {
        const next = {
          region: r ?? prev.region,
          inView: r !== undefined,
          active,
          ready: true,
        };
        return (
            prev.ready
              && prev.region === next.region
              && prev.inView === next.inView
              && prev.active === next.active
          ) ?
            prev
          : next;
      });
    };
    update();
    map.on("moveend", update);
    return () => {
      map.off("moveend", update);
    };
  }, [map]);
  return state;
}

/** What the overview draws: every region's feed. */
const OVERVIEW_DATASETS = REGIONS.map((r) => r.config.feed.dataset);

/**
 * Every region's routes zoomed out (packages/transit-core/DESIGN.md#overview-tiles), below the zoom
 * a region's engine starts at, and further in until the engine draws its own lines (so zooming in
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
  React.useEffect(() => {
    if (!map) return;
    const layers = overviewLayers(OVERVIEW_SOURCE, theme, maxzoomRef.current);
    for (const layer of layers)
      if (!map.getLayer(layer.id)) map.addLayer(layer);
    return () => {
      for (const layer of layers)
        if (map.getLayer(layer.id)) map.removeLayer(layer.id);
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
 * controls. The engine draws every frame on its own; React only sees its snapshot store.
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
  const { region, inView, active, ready } = useRegion(map);
  // The region whose engine is kept: the last one zoomed in to. Zoomed out, its engine is hidden
  // (and paused) rather than disposed, so zooming back in shows it at once; zooming in to
  // another region replaces it.
  const [kept, setKept] = React.useState<SiteRegion>();
  React.useEffect(() => {
    if (ready && active) setKept(region);
  }, [ready, active, region]);
  const shown = active && kept === region;
  useOverview(map, theme, shown ? engine : undefined);
  // The first engine takes its selection from the URL; one for a region panned to later starts
  // without it (a vehicle or place of another region), at the same time, unless the map moved
  // there to find the selection (`carry`, from the feature resolver).
  const shownRegion = React.useRef<string>(undefined);
  const carry = React.useRef<{ key: string; region: string }>(undefined);

  React.useEffect(() => {
    if (!map || !kept) return;
    const region = kept;
    let cancelled = false;
    let created: TransitEngine | undefined;
    const params = new URLSearchParams(location.search);
    const { select: _s, ...time } = readUrl();
    // A key carried for this region is used once its engine starts; one for another region (the
    // user panned elsewhere first) is dropped.
    const select =
      carry.current?.region === region.info.id ? carry.current.key : undefined;
    if (!select) carry.current = undefined;
    const switched =
      shownRegion.current !== undefined
      && shownRegion.current !== region.info.id;
    shownRegion.current = region.info.id;
    setError(undefined);
    TransitEngine.create(map, {
      dataBase: transitData,
      apiBase: transitApi,
      region: region.info.id,
      theme: themeRef.current,
      scenario: params.get("scenario") ?? undefined,
      debug: params.has("debug"),
      dataset: region.config.feed.dataset,
      config: region.config,
      onRebuilt: () => setBuild((b) => b + 1),
      ...(switched ?
        { initial: { ...time, ...(select ? { select } : {}) } }
      : {}),
    }).then(
      (eng) => {
        if (cancelled) {
          eng.dispose();
          return;
        }
        created = eng;
        if (select) carry.current = undefined;
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
  }, [map, kept, build]);

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
      {error && active ?
        <MapOverlayWindow className="top-5 sm:top-24 text-red-700 dark:text-red-300">
          <div role="alert">{error}</div>
        </MapOverlayWindow>
      : null}
      {!inView ?
        <MapOverlayWindow className="top-5 sm:top-24">
          Transit data isn't available here yet. Go to{" "}
          {REGIONS.map((r, i) => (
            <React.Fragment key={r.info.id}>
              {i === 0 ?
                ""
              : i === REGIONS.length - 1 ?
                " or "
              : ", "}
              <button
                type="button"
                className="underline"
                onClick={() =>
                  map && showBounds(map, lngLatBounds(r.info.initialBounds))
                }>
                {r.info.name}
              </button>
            </React.Fragment>
          ))}
          .
        </MapOverlayWindow>
      : null}
      {engine && shown ?
        <EngineControls
          engine={engine}
          onElsewhere={(key, bounds) => {
            // Carried only to another region, whose engine will select it. A feature in this
            // region that its plan doesn't have (a stop no drawn route serves) can't be selected:
            // the map just shows where it is.
            const [w, s, e, n] = bounds;
            const pad = 1e-5;
            const target = regionInView({
              west: w - pad,
              south: s - pad,
              east: e + pad,
              north: n + pad,
            });
            carry.current =
              target && target.info.id !== region.info.id ?
                { key, region: target.info.id }
              : undefined;
            if (map) showBounds(map, lngLatBounds(bounds), { maxZoom: 16 });
          }}
        />
      : null}
    </>
  );
}

const EngineControls: React.FC<{
  engine: TransitEngine;
  /** A selected feature is elsewhere: move the map there (another region's engine selects it). */
  onElsewhere: (key: string, bounds: [number, number, number, number]) => void;
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
 * A `?select=` key the region's plan doesn't have: ask the feature resolver where it is
 * (apps/server/README.md#feature-resolver), so the map can move to its region.
 */
function useElsewhere(
  key: string | undefined,
  onFound: (key: string, bounds: [number, number, number, number]) => void,
): void {
  const found = React.useRef(onFound);
  found.current = onFound;
  React.useEffect(() => {
    if (!key || !transitApi) return;
    let cancelled = false;
    fetch(`${transitApi}features/${encodeURIComponent(key)}`)
      .then((r) =>
        r.ok ?
          (r.json() as Promise<{
            bbox: [number, number, number, number] | null;
          }>)
        : null,
      )
      .then((f) => {
        if (!cancelled && f?.bbox) found.current(key, f.bbox);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [key]);
}
