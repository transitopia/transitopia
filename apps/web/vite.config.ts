import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The standalone transit viewer (packages/transit-map) uses 5173.
  server: { port: 5174 },
  // MapLibre GL starts its worker with {type: "module"}, so it has to be built as an ES module.
  worker: { format: "es" },
});
