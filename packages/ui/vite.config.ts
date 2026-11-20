// Builds the app in `app/` into `dist/app`, which the daemon serves (D-024).
// Tailwind v4 compiles app/src/index.css at build time (D-025), so the page needs no inline style.
// `pnpm dev` proxies /api to a running `harnessd run` on the default port.
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  root: "app",
  base: "/",
  plugins: [tailwindcss()],
  build: {
    outDir: "../dist/app",
    emptyOutDir: true,
    // No inline polyfill: the page's CSP allows only its own scripts.
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    target: "es2023",
  },
  server: {
    proxy: { "/api": { target: "http://127.0.0.1:4747", changeOrigin: true } },
  },
});
