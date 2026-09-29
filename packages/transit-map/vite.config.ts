import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { rtServicePlugin } from "@transitopia/server/vite-plugin.ts";

export default defineConfig({
  plugins: [rtServicePlugin()],
  // Build output from the pipelines (/data, /tiles, /basemap-assets); see pipelines/lib/paths.ts.
  publicDir: fileURLToPath(new URL("../../var/public", import.meta.url)),
  server: { port: 5173 },
  // MapLibre alone is ~1 MB minified; one app chunk is fine for a map-first page.
  build: { target: "es2022", sourcemap: true, chunkSizeWarningLimit: 1500 },
  // maplibre-gl creates its worker with { type: 'module' }.
  worker: { format: "es" },
});
