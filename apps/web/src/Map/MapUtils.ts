import React from "react";
import type * as MapLibreGL from "maplibre-gl";
export type MapLibreGLType = typeof MapLibreGL;
export type MapType = MapLibreGL.Map;

export const MapContext = React.createContext<{
  map: MapLibreGL.Map | undefined;
  /**
   * Bumped each time a new style finishes loading (a theme switch). Overlays add their layers in
   * an effect that depends on it, since a new style drops them.
   */
  styleGeneration: number;
}>({ map: undefined, styleGeneration: 0 });

export const MapLibreGLContext: React.Context<{ maplibregl?: MapLibreGLType }> =
  React.createContext({});

export const useMap = () => React.useContext(MapContext)?.map;
export const useStyleGeneration = () =>
  React.useContext(MapContext).styleGeneration;

/**
 * Register an event handler for a map event, but limited to a specific layer of the map
 * @param eventName The event to handle
 * @param handler The handler to call
 * @param layerName Which map layers to watch for the event
 */
export function useMapLayerEvent<
  eventName extends "click" | "mouseenter" | "mouseleave" | "mousemove",
>(
  eventName: eventName,
  handler: (event: MapLibreGL.MapLayerEventType[eventName]) => void,
  ...layerNames: string[]
) {
  const map = useMap();
  React.useEffect(() => {
    if (!map) return;
    layerNames.forEach((layerName) => map.on(eventName, layerName, handler));
    // Cleanup when the handler changes or the component is destroyed:
    return () => {
      layerNames.forEach(
        // prettier-ignore https://github.com/prettier/prettier/issues/2856
        (layerName) => map?.off(eventName, layerName, handler),
      );
    };
  }, [map, eventName, handler, ...layerNames]); // Note: without '...', layerNames would be shown as changing every time.
}
