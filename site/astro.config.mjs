import {svelte} from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from "astro/config";
import { fileURLToPath } from "node:url";
import { profile } from "./product-profile.mjs";

const base = process.env.OURNOTES_SITE_BASE || "/";
const outDir = process.env.OURNOTES_SITE_OUT_DIR || "./dist";
const publicDir = process.env.OURNOTES_SITE_PUBLIC_DIR || "./public";
const cacheDir =
  process.env.OURNOTES_ASTRO_CACHE_DIR || "./node_modules/.astro";
const viteCacheDir =
  process.env.OURNOTES_VITE_CACHE_DIR || "./node_modules/.vite";
const projectionDataRoot =
  process.env.OURNOTES_PROJECTION_DATA_ROOT ||
  fileURLToPath(new URL("./src/data/generated", import.meta.url));
const anontokyoEnabled = (
  process.env.PUBLIC_ANONTOKYO_ENABLED === "1" ||
  process.env.OURNOTES_ANONTOKYO_ENABLED === "1" ||
  process.env.OURNOTES_ANONTOKYO_PRIVATE_PREVIEW === "1");

const integrations = anontokyoEnabled
  ? [
      {
        name: "ournotes-anontokyo-routes",
        hooks: {
          "astro:config:setup": ({ injectRoute }) => {
            injectRoute({
              pattern: "/anontokyo/[...view]",
              entrypoint: new URL(
                "./src/private-pages/anontokyo/[...view].astro",
                import.meta.url
              ),
              prerender: true
            });
          }
        }
      }
    ]
  : [];

export default defineConfig({
  output: "static",
  base,
  outDir,
  publicDir,
  cacheDir,
  trailingSlash: "always",
  build: {
    format: "directory"
  },
  integrations,
  vite: {
    plugins: [svelte()],
    define: {
      "import.meta.env.PUBLIC_SITE_PROFILE": JSON.stringify(profile),
      // Preserve the source location when the server loader is bundled for prerendering.
      "import.meta.env.OURNOTES_RANKING_SOURCE_ROOT": JSON.stringify(fileURLToPath(new URL("./src/lib/", import.meta.url)))
    },
    cacheDir: viteCacheDir,
    resolve: {
      alias: {
        "@projection-data": projectionDataRoot
      }
    },
    server: {
      host: "127.0.0.1",
      ...(process.env.OURNOTES_GROWTH_GATEWAY ? {proxy: {
        "/api/growth-export/": {target: process.env.OURNOTES_GROWTH_GATEWAY, changeOrigin: false}
      }} : {})
    }
  }
});
