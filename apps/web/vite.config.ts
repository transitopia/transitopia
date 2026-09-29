import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // MapLibre GL starts its worker with {type: "module"}, so it has to be built as an ES module.
  worker: { format: "es" },
});
