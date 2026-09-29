import { defineConfig } from 'vite';
import { rtServicePlugin } from './server/vite-plugin.ts';

export default defineConfig({
  plugins: [rtServicePlugin()],
  server: { port: 5173 },
  // MapLibre alone is ~1 MB minified; one app chunk is fine for a map-first page.
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 1500 },
  // maplibre-gl creates its worker with { type: 'module' }.
  worker: { format: 'es' },
});
