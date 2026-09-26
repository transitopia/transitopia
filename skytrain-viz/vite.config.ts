import { defineConfig } from 'vite';
import { rtServicePlugin } from './server/vite-plugin.ts';

export default defineConfig({
  plugins: [rtServicePlugin()],
  server: { port: 5173 },
  build: { target: 'es2022', sourcemap: true },
});
