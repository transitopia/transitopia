import React from "react";

import { layers } from "./walking-map-layers.ts";
import { useMap, useMapZoom } from "../Map/MapUtils.ts";
import { MapOverlayWindow } from "../Map/MapOverlayWindow.tsx";

export const WalkingMap: React.FC = () => {
  const map = useMap();
  const zoom = useMapZoom();

  // Add the walking layers to the map:
  React.useEffect(() => {
    if (!map) return;
    for (const layer of layers) {
      map.addLayer(layer);
    }
    return () => {
      for (const layer of layers) {
        map.removeLayer(layer.id);
      }
    };
  });

  return (
    <>
      <MapOverlayWindow className="top-24">
        The Transitopia walking map is not yet developed, but for now you can
        see all the known pedestrian paths from OpenStreetMap.
      </MapOverlayWindow>
      {zoom < 14 ?
        <MapOverlayWindow className="top-56 lg:top-48">
          Zoom in to see walkways.
        </MapOverlayWindow>
      : null}
    </>
  );
};
