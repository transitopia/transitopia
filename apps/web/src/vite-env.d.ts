/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BASEMAP_TILES?: string;
  readonly VITE_BASEMAP_ASSETS?: string;
  readonly VITE_CYCLING_MAP_TILES_CDN?: string;
  readonly VITE_TRANSIT_DATA?: string;
  readonly VITE_TRANSIT_API?: string;
}
