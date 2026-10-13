import React from "react";
import type * as MapLibreGL from "maplibre-gl";

import {
  cyclingFilters,
  cyclingLayers,
  mapSource,
  otherLayerIds,
  pathLayerIds,
} from "./cycling-map-layers.ts";
import {
  useMap,
  useMapLayerEvent,
  useStyleGeneration,
} from "../Map/MapUtils.ts";
import { useTheme } from "../Theme/Theme.tsx";
import { useDatasets } from "../Attribution/Attribution.tsx";
import {
  type MapCyclingElement,
  type MapParkingElement,
} from "../Map/MapData.ts";
import { BikeParkingCard } from "./BikeParkingCard.tsx";
import { BikeRouteCard } from "./BikeRouteCard.tsx";
import { CyclingLayers, useCyclingShow } from "./CyclingLayers.tsx";

export const CyclingMap: React.FC = () => {
  const map = useMap();
  const { theme } = useTheme();
  const styleGeneration = useStyleGeneration();
  // The cycling layer is derived from OpenStreetMap by our Planetiler profile (map-layers/).
  useDatasets(["osm", "transitopia"]);
  const [show, setShow] = useCyclingShow();
  const showRef = React.useRef(show);
  showRef.current = show;

  // Add the cycling layers to the map, again after a theme switch replaces the style:
  React.useEffect(() => {
    if (!map) return;
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
  }, [map, theme, styleGeneration]);

  // What the layers panel shows: filter the layers in place.
  React.useEffect(() => {
    if (!map) return;
    for (const [id, filter] of Object.entries(cyclingFilters(show)))
      if (map.getLayer(id)) map.setFilter(id, filter);
  }, [map, show]);

  const [selectedFeature, setSelectedFeature] = React.useState<
    MapCyclingElement | MapParkingElement
  >();
  /** Where the selected feature was clicked, for "Centre on map". */
  const [selectedAt, setSelectedAt] = React.useState<MapLibreGL.LngLat>();
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
              sourceLayer: "transitopia_cycling",
              id: hoveredFeatureIdRef.current,
            },
            "hover",
          );
        }
        hoveredFeatureIdRef.current = feature.id as string;
        map.setFeatureState(
          {
            source: mapSource,
            sourceLayer: "transitopia_cycling",
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
          sourceLayer: "transitopia_cycling",
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
            sourceLayer: "transitopia_cycling",
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
      setSelectedAt(e.lngLat);
      setSelectedFeature({
        id: feature.id as string,
        type: "cycling_way",
        ...feature.properties,
      } as MapCyclingElement);
    },
    [map],
  );

  const handlePointClick = React.useCallback(
    (e: MapLibreGL.MapLayerEventType["click"]) => {
      const feature = e.features?.[0];
      if (!map || map.getZoom() < 13 || !feature) return;
      setSelectedAt(e.lngLat);
      setSelectedFeature({
        id: feature.id as string,
        type: "bicycle_parking",
        ...(feature.properties as any),
      } as MapParkingElement);
    },
    [map],
  );

  useMapLayerEvent("click", handleClick, ...pathLayerIds);
  useMapLayerEvent("click", handlePointClick, ...otherLayerIds);

  React.useEffect(() => {
    if (!map) return;
    if (selectedFeature) {
      map.setFeatureState(
        {
          source: mapSource,
          sourceLayer: "transitopia_cycling",
          id: selectedFeature.id,
        },
        { selected: true },
      );
      return () => {
        map.removeFeatureState(
          {
            source: mapSource,
            sourceLayer: "transitopia_cycling",
            id: selectedFeature.id,
          },
          "selected",
        );
      };
    }
  }, [map, selectedFeature]);

  const closeInfobox = React.useCallback(() => {
    setSelectedFeature(undefined);
  }, []);
  const centre = React.useCallback(() => {
    if (map && selectedAt)
      map.easeTo({ center: selectedAt, zoom: Math.max(map.getZoom(), 15) });
  }, [map, selectedAt]);

  return (
    <>
      <CyclingLayers show={show} onChange={setShow} />
      {selectedFeature?.type === "cycling_way" ?
        <BikeRouteCard
          feature={selectedFeature}
          onCentre={centre}
          onClose={closeInfobox}
        />
      : selectedFeature?.type === "bicycle_parking" ?
        (() => {
          const way = selectedFeature.osmWayId;
          const node = selectedFeature.osmNodeId;
          const id = Number.parseInt(way ?? node ?? "", 10);
          return Number.isFinite(id) ?
              <BikeParkingCard
                key={id}
                featureType={way ? "way" : "node"}
                osmId={id}
                onCentre={centre}
                onClose={closeInfobox}
              />
            : null;
        })()
      : null}
    </>
  );
};
