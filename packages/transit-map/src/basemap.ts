// Basemap style: Protomaps layers over the local PMTiles extract, with local glyphs and sprites
// (pipelines/tiles.ts). Nothing here calls third-party servers.

import type { StyleSpecification } from "@maplibre/maplibre-gl-style-spec";
import { layers, namedFlavor, type Flavor } from "@protomaps/basemaps";

export type Theme = "light" | "dark";

export const BASEMAP_SOURCE = "protomaps";

/** Absolute URL without URL() normalisation, which would percent-encode {fontstack}/{range} tokens. */
function absolute(path: string): string {
  const base =
    import.meta.env.BASE_URL.startsWith("/") ?
      import.meta.env.BASE_URL
    : `/${import.meta.env.BASE_URL}`;
  return `${location.origin}${base}${path}`;
}

/**
 * Muted base flavours (Protomaps "white"/"black") with a light tint on water and parks, so the
 * transit lines carry the colour.
 */
const SPRITE: Record<Theme, string> = { light: "white", dark: "black" };
function flavor(theme: Theme): Flavor {
  if (theme === "light") {
    const park = "#e9f0e5";
    return {
      ...namedFlavor("white"),
      background: "#f5f4f1",
      earth: "#f5f4f1",
      water: "#c9d9e5",
      park_a: park,
      park_b: park,
      wood_a: park,
      wood_b: park,
      scrub_a: park,
      scrub_b: park,
    };
  }
  const park = "#172019";
  return {
    ...namedFlavor("black"),
    background: "#15181c",
    earth: "#15181c",
    water: "#1b2733",
    park_a: park,
    park_b: park,
    wood_a: park,
    wood_b: park,
    scrub_a: park,
    scrub_b: park,
  };
}

export function basemapStyle(theme: Theme): StyleSpecification {
  const f = flavor(theme);
  return {
    version: 8,
    glyphs: absolute("basemap-assets/fonts/{fontstack}/{range}.pbf"),
    sprite: absolute(`basemap-assets/sprites/v4/${SPRITE[theme]}`),
    sources: {
      [BASEMAP_SOURCE]: {
        type: "vector",
        url: `pmtiles://${absolute("tiles/vancouver.pmtiles")}`,
        attribution:
          '<a href="https://protomaps.com">Protomaps</a> © <a href="https://openstreetmap.org/copyright">OpenStreetMap</a> · Schedule data © <a href="https://www.translink.ca">TransLink</a>',
      },
    },
    layers: layers(BASEMAP_SOURCE, f, { lang: "en" }),
  };
}
