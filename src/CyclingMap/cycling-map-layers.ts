// Transitopia Cycling map style for MapLibre GL
// By Braden MacDonald
// Code license: MIT (see repository's LICENSE file) 
// Design license: CC-BY 4.0 https://creativecommons.org/licenses/by/4.0/

import type { ExpressionSpecification, LayerSpecification } from "maplibre-gl";
import { defaultLineLayout, interpolateZoom, mapSource as baseMapSource } from "../Map/basemap-layers.ts";

// Which map "source" file (which .pmtiles file) the cycling data layers are found in
export const mapSource = "transitopia-cycling";

/** Layers with cycling paths, as opposed to other things like bike rack locations */
export const pathLayerIds = [
    "cycling_path_1",
    "cycling_path_2",
    "cycling_path_3",
    "cycling_path_4",
    "cycling_path_construction"
];
export const otherLayerIds = ["bike_parking_point"];

/**
 * Helper: the resulting color should normally be 'color',
 * but make it salmon colored when hovered or selected.
 */
export const colorWithHoverAndSelectionStates = (color: string) => [
    "case",
    ["boolean", ["feature-state", "selected"], false], "rgba(200, 100, 100, 1)",
    ["boolean", ["feature-state", "hover"], false], "rgba(200, 100, 100, 1)",
    color,
] satisfies ExpressionSpecification;

export const layers: LayerSpecification[] = [
    {
        id: "cycling_path_construction",
        type: "line",
        source: mapSource,
        "source-layer": "transitopia_cycling",
        "filter": [
            "all",
            ["==", "$type", "LineString"],
            ["==", "construction", true],
        ],
        "layout": {
            "line-cap": "butt",
            "line-join": "bevel",
            "visibility": "visible",
        },
        "paint": {
            "line-color": colorWithHoverAndSelectionStates("rgba(226, 109, 35, 1)"),
            "line-width": interpolateZoom({ z10: 3, z16: 4 }),
            "line-dasharray": [0.4, 1],
        },
    },
    {
        id: "cycling_path_4",
        type: "line",
        source: mapSource,
        "source-layer": "transitopia_cycling",
        "filter": [
            "all",
            ["==", "$type", "LineString"],
            ["==", "comfort", 4],
            ["!=", "construction", true],
        ],
        layout: defaultLineLayout,
        "paint": {
            "line-color": colorWithHoverAndSelectionStates("rgba(26, 109, 35, 1)"),
            "line-width": interpolateZoom({ z10: 2, z16: 8 }),
        },
    },
    {
        id: "cycling_path_3",
        type: "line",
        source: mapSource,
        "source-layer": "transitopia_cycling",
        "filter": [
            "all",
            ["==", "$type", "LineString"],
            ["==", "comfort", 3],
            ["!=", "construction", true],
        ],
        layout: defaultLineLayout,
        "paint": {
            "line-color": colorWithHoverAndSelectionStates("rgba(26, 109, 35, 1)"),
            "line-width": interpolateZoom({ z10: 2, z16: 7 }),
        },
    },
    {
        // Draw white centre lines overtop of "comfort level 3" cycling paths
        id: "cycling_path_3_inner",
        type: "line",
        source: mapSource,
        "source-layer": "transitopia_cycling",
        "minzoom": 13,
        "filter": [
            "all",
            ["==", "$type", "LineString"],
            ["==", "comfort", 3],
            ["!=", "construction", true],
        ],
        layout: defaultLineLayout,
        "paint": {
            "line-color": "rgba(255, 255, 255, 0.6)",
            "line-width": 2,
            "line-dasharray": [2, 4],
        },
    },
    {
        id: "cycling_path_2",
        type: "line",
        source: mapSource,
        "source-layer": "transitopia_cycling",
        "filter": [
            "all",
            ["==", "$type", "LineString"],
            ["==", "comfort", 2],
            ["!=", "construction", true],
        ],
        layout: defaultLineLayout,
        "paint": {
            "line-color": colorWithHoverAndSelectionStates("rgba(26, 109, 35, 1)"),
            "line-width": interpolateZoom({ z10: 3, z16: 6 }),
            // dashed lines when zoomed in greater than 12
            "line-dasharray": {
                type: "interval",
                stops: [[0, [1]], [12, [0.4, 1.4]]],
            },
        },
    },
    {
        id: "cycling_path_1",
        type: "line",
        source: mapSource,
        "source-layer": "transitopia_cycling",
        minzoom: 8,
        "filter": [
            "all",
            ["==", "$type", "LineString"],
            ["==", "comfort", 1],
            ["!=", "construction", true],
        ],
        layout: defaultLineLayout,
        "paint": {
            "line-color": colorWithHoverAndSelectionStates("rgba(26, 50, 35, 1)"),
            "line-width": interpolateZoom({ z10: 2, z16: 4 }),
            "line-dasharray": [0.3, 2],
        },
    },
    {
        id: "cycling_path_name",
        type: "symbol",
        // TODO: move the cycling path names into our Transitopia cycling layer
        source: baseMapSource,
        "source-layer": "transportation_name",
        "filter": [
            "all",
            ["!=", "class", "motorway"],
            ["==", "$type", "LineString"],
            ["==", "subclass", "cycleway"],
        ],
        "layout": {
            "symbol-placement": "line",
            "symbol-spacing": 350,
            "text-field": "{name:latin} {name:nonlatin}",
            "text-font": ["Metropolis Regular"],
            "text-max-angle": 30,
            "text-pitch-alignment": "viewport",
            "text-rotation-alignment": "map",
            "text-offset": [0, 1.1],
            "text-size": 10,
            "text-transform": "uppercase",
            "visibility": "visible",
        },
        "paint": {
            "text-color": "rgba(24, 79, 19, 1)",
            "text-halo-blur": 1,
            "text-halo-color": "rgba(231, 231, 131, 0.72)",
            "text-halo-width": 2,
        },
    },
    // Bike parking (points)
    {
        id: "bike_parking_point",
        type: "circle",
        source: mapSource,
        "source-layer": "transitopia_cycling",
        "filter": [
            "all",
            ["==", "$type", "Point"],
            ["==", "amenity", "bicycle_parking"],
        ],
        layout: {
            visibility: "visible",
            "circle-sort-key": 1,
        },
        "paint": {
            "circle-radius": interpolateZoom({ z8: 1, z12: 1, z16: 3 }),
            "circle-color": "rgba(231, 231, 131, 0.72)",
            "circle-stroke-width": interpolateZoom({ z8: 0.5, z12: 0.5, z16: 2 }),
            "circle-stroke-color": colorWithHoverAndSelectionStates("rgba(26, 109, 35, 1)"),
            "circle-stroke-opacity": interpolateZoom({ z12: 0, z14: 0.5, z16: 0.8 }),
        },
    },
];
