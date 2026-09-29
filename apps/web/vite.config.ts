import { cp, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import sirv from "sirv";

/** Pipeline output (pipelines/lib/paths.ts): tiles, basemap assets and transit data. */
const VAR_PUBLIC = fileURLToPath(new URL("../../var/public", import.meta.url));

/**
 * Development: serve var/public at /dev-data/ (with range requests, which PMTiles needs), so the
 * site reads the local basemap extract and transit data (src/config.ts).
 */
function devData(): Plugin {
  return {
    name: "transitopia-dev-data",
    apply: "serve",
    configureServer(server) {
      const serve = sirv(VAR_PUBLIC, { dev: true, etag: true });
      server.middlewares.use("/dev-data", (req, res, next) =>
        serve(req, res, next),
      );
    },
  };
}

/** Production: the basemap fonts and sprites ship with the site, at /basemap-assets/. */
function basemapAssets(): Plugin {
  let outDir = "dist";
  return {
    name: "transitopia-basemap-assets",
    apply: "build",
    configResolved(config) {
      outDir = config.build.outDir;
    },
    async closeBundle() {
      const src = `${VAR_PUBLIC}/basemap-assets`;
      await stat(src).catch(() => {
        throw new Error(
          `${src} is missing: run "npm run tiles -- --assets-only" first.`,
        );
      });
      await cp(src, `${outDir}/basemap-assets`, { recursive: true });
    },
  };
}

/** Cloudflare Web Analytics (cookieless; V2-PLAN.md §7.6), when a site token is configured. */
function analytics(token: string | undefined): Plugin {
  return {
    name: "transitopia-analytics",
    transformIndexHtml() {
      if (!token) return [];
      return [
        {
          tag: "script",
          attrs: {
            defer: true,
            src: "https://static.cloudflareinsights.com/beacon.min.js",
            "data-cf-beacon": JSON.stringify({ token }),
          },
          injectTo: "body",
        },
      ];
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [
      react(),
      tailwindcss(),
      devData(),
      basemapAssets(),
      analytics(env.CF_WEB_ANALYTICS_TOKEN),
    ],
    server: { port: 5173 },
    // MapLibre GL starts its worker with {type: "module"}, so it has to be built as an ES module.
    worker: { format: "es" },
    // MapLibre alone is ~1 MB minified (a lazy chunk of its own); the transit engine is another.
    build: { sourcemap: true, chunkSizeWarningLimit: 1500 },
  };
});
