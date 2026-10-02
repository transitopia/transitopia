// The site's basemap: Protomaps layers over a PMTiles extract (docs/DESIGN.md#regions), with
// self-hosted glyphs and sprites (pipelines/tiles.ts). Nothing here calls third-party servers.

import type {
  SpriteSpecification,
  StyleSpecification,
} from "@maplibre/maplibre-gl-style-spec";
import { layers, namedFlavor, type Flavor } from "@protomaps/basemaps";

export type Theme = "light" | "dark";

export const BASEMAP_SOURCE = "protomaps";

/** Fonts in the self-hosted glyph set; overlays must use one of these. */
export const FONTS = {
  regular: ["Noto Sans Regular"],
  medium: ["Noto Sans Medium"],
  italic: ["Noto Sans Italic"],
} as const;

export interface BasemapOptions {
  theme: Theme;
  /**
   * The vector source: a TileJSON URL (the tile server in production) or `pmtiles://<absolute URL>`
   * of a local extract.
   */
  tiles: string;
  /** Absolute URL of the basemap assets (fonts/, sprites/), ending in "/". */
  assets: string;
  /** Extra sprite sheets for overlays; their icons are referenced as "<id>:<icon>". */
  sprites?: { id: string; url: string }[];
}

/**
 * Muted base flavours (Protomaps "white"/"black") with a light tint on water and parks, so the
 * overlays (transit lines, cycling routes) carry the colour.
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

export function basemapStyle(o: BasemapOptions): StyleSpecification {
  const sprite: SpriteSpecification = [
    { id: "default", url: `${o.assets}sprites/v4/${SPRITE[o.theme]}` },
    ...(o.sprites ?? []),
  ];
  return {
    version: 8,
    // Not normalised through URL(), which would percent-encode the {fontstack}/{range} tokens.
    glyphs: `${o.assets}fonts/{fontstack}/{range}.pbf`,
    sprite,
    sources: {
      // Credits come from the site's attribution control (docs/DESIGN.md#attribution), not the source.
      [BASEMAP_SOURCE]: { type: "vector", url: o.tiles },
    },
    layers: layers(BASEMAP_SOURCE, flavor(o.theme), { lang: "en" }),
  };
}

/** Theme for a preference, following the system setting for "auto". */
export function resolveTheme(pref: Theme | "auto"): Theme {
  if (pref !== "auto") return pref;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ?
      "dark"
    : "light";
}
