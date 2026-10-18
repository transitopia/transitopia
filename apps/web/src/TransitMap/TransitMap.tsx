import React from "react";
import {
  TransitEngine,
  type TransitSnapshot,
} from "@transitopia/transit-map/engine.ts";
import { readUrl } from "@transitopia/transit-map/url.ts";

import { transitApi, transitData } from "../config.ts";
import { openedPath, openedWithPosition } from "../startup.ts";
import { useMap, type MapType } from "../Map/MapUtils.ts";
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
      map.fitBounds(lngLatBounds(DEFAULT_REGION.info.initialBounds), {
        padding: PADDING,
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
  /** Whether the map has been looked at yet (until then `region` is only the default). */
  ready: boolean;
}

/**
 * The region the engine shows (docs/DESIGN.md#regions-and-feeds): the one in view, or while the
 * view is outside every region, the last one shown (at first, the default).
 */
function useRegion(map: MapType | undefined): RegionState {
  const [state, setState] = React.useState<RegionState>({
    region: DEFAULT_REGION,
    inView: true,
    ready: false,
  });
  React.useEffect(() => {
    if (!map) return;
    const update = () => {
      const r = viewOf(map);
      setState((prev) =>
        r ?
          prev.ready && prev.region === r && prev.inView ?
            prev
          : { region: r, inView: true, ready: true }
        : prev.ready && !prev.inView ? prev
        : { region: prev.region, inView: false, ready: true },
      );
    };
    update();
    map.on("moveend", update);
    return () => {
      map.off("moveend", update);
    };
  }, [map]);
  return state;
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
  useInitialView(map);
  const { region, inView, ready } = useRegion(map);
  // The first engine takes its selection from the URL; one for a region panned to later starts
  // without it (a vehicle or place of another region), at the same time.
  const shownRegion = React.useRef<string>(undefined);

  React.useEffect(() => {
    if (!map || !ready) return;
    let cancelled = false;
    let created: TransitEngine | undefined;
    const params = new URLSearchParams(location.search);
    const { vehicle: _v, place: _p, ...time } = readUrl();
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
      ...(switched ? { initial: time } : {}),
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
  }, [map, region, ready]);

  // Runs before the map swaps its style (child effects run first), so the engine re-adds its
  // layers in the new theme's colours when the new style loads.
  React.useEffect(() => {
    themeRef.current = theme;
    engine?.setTheme(theme);
  }, [engine, theme]);

  return (
    <>
      {error ?
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
                  map?.fitBounds(lngLatBounds(r.info.initialBounds), {
                    padding: PADDING,
                  })
                }>
                {r.info.name}
              </button>
            </React.Fragment>
          ))}
          .
        </MapOverlayWindow>
      : null}
      {engine ?
        <EngineControls engine={engine} />
      : null}
    </>
  );
}

const EngineControls: React.FC<{ engine: TransitEngine }> = ({ engine }) => {
  const snap: TransitSnapshot = React.useSyncExternalStore(
    engine.subscribe,
    engine.getSnapshot,
  );
  useDatasets(snap.datasets);
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
