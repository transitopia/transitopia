# @transitopia/map-style

The site's basemap style: [Protomaps](https://protomaps.com/) layers (`@protomaps/basemaps`) in light and dark flavours, muted so transit and cycling overlays stand out, over a PMTiles extract of British Columbia.

- `src/basemap.ts`: `basemapStyle({ … })` for a theme, `resolveTheme()`, the font list overlays must use (`FONTS`), and the sprite. Glyphs and sprites are self-hosted (`npm run tiles` copies them into `var/public/basemap-assets/`, and the site's build into `/basemap-assets/`), so the map calls no third-party servers.
- `src/zoom.ts`: zoom-dependent style helpers shared by the overlays.

The basemap itself is built by `npm run tiles -- --region bc` locally and weekly by `.github/workflows/build_basemap.yml` for production ([deployment/README.md → Map tiles](../../deployment/README.md#map-tiles-map-tilestransitopiaorg)). Its credits come from the site's attribution control, not the map source.
