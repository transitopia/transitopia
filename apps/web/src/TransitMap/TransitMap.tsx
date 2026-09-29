import React from "react";
import {
  TransitEngine,
  type TransitSnapshot,
} from "@transitopia/transit-map/engine.ts";
import region from "@transitopia/region-metro-vancouver/region.json";

import { transitApi, transitData } from "../config.ts";
import { openedPath, openedWithPosition } from "../startup.ts";
import { useMap, type MapType } from "../Map/MapUtils.ts";
import { MapOverlayWindow } from "../Map/MapOverlayWindow.tsx";
import { useTheme } from "../Theme/Theme.tsx";
import { useDatasets } from "../Attribution/Attribution.tsx";
import { TimeBar } from "./TimeBar.tsx";
import { TransitLegend } from "./TransitLegend.tsx";
import { VehicleCard } from "./VehicleCard.tsx";

const [w, s, e, n] = region.initialBounds;
const INITIAL_BOUNDS: [[number, number], [number, number]] = [
  [w!, s!],
  [e!, n!],
];
const PADDING = { top: 90, bottom: 150, left: 20, right: 50 };

/**
 * Show the whole network when the site was opened on /transit (or /) without a map position. Only
 * once: switching modes later keeps wherever the map is.
 */
let initialViewDone = false;
function useInitialView(map: MapType | undefined): void {
  React.useEffect(() => {
    if (!map || initialViewDone) return;
    initialViewDone = true;
    const openedOnTransit =
      openedPath === "/" || openedPath.startsWith("/transit");
    if (openedOnTransit && !openedWithPosition)
      map.fitBounds(INITIAL_BOUNDS, { padding: PADDING, animate: false });
  }, [map]);
}

/** Does the map view overlap the region's transit data? */
function viewInRegion(map: MapType): boolean {
  const b = map.getBounds();
  const [west, south, east, north] = region.bbox;
  return !(
    b.getEast() < west!
    || b.getWest() > east!
    || b.getNorth() < south!
    || b.getSouth() > north!
  );
}

/**
 * /transit (V2-PLAN.md §4.2, §5.2): mounts the transit engine on the shared map and renders its
 * controls. The engine draws every frame on its own; React only sees its snapshot store.
 */
export default function TransitMap() {
  const map = useMap();
  const { theme } = useTheme();
  const themeRef = React.useRef(theme);
  const [engine, setEngine] = React.useState<TransitEngine>();
  const [error, setError] = React.useState<string>();
  const [inRegion, setInRegion] = React.useState(true);
  useInitialView(map);

  React.useEffect(() => {
    if (!map) return;
    let cancelled = false;
    let created: TransitEngine | undefined;
    const params = new URLSearchParams(location.search);
    TransitEngine.create(map, {
      dataBase: transitData,
      apiBase: transitApi,
      theme: themeRef.current,
      scenario: params.get("scenario") ?? undefined,
      debug: params.has("debug"),
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
  }, [map]);

  // Runs before the map swaps its style (child effects run first), so the engine re-adds its
  // layers in the new theme's colours when the new style loads.
  React.useEffect(() => {
    themeRef.current = theme;
    engine?.setTheme(theme);
  }, [engine, theme]);

  React.useEffect(() => {
    if (!map) return;
    const update = () => setInRegion(viewInRegion(map));
    update();
    map.on("moveend", update);
    return () => {
      map.off("moveend", update);
    };
  }, [map]);

  return (
    <>
      {error ?
        <MapOverlayWindow className="top-24 text-red-700 dark:text-red-300">
          <div role="alert">{error}</div>
        </MapOverlayWindow>
      : null}
      {!inRegion ?
        <MapOverlayWindow className="top-24">
          Transit data isn't available here yet.{" "}
          <button
            type="button"
            className="underline"
            onClick={() =>
              map?.fitBounds(INITIAL_BOUNDS, { padding: PADDING })
            }>
            Go to {region.name}
          </button>
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
  return (
    <>
      <TransitLegend engine={engine} snap={snap} />
      <VehicleCard engine={engine} snap={snap} />
      <TimeBar engine={engine} snap={snap} />
    </>
  );
};
