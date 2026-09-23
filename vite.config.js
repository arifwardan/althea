import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// Dashboard Althea: dev `npm run dev:web` (5173, proxy /api → :9999),
// build `npm run build:web` → public/ (disajikan backend http bawaan).
export default defineConfig({
  root: "web",
  plugins: [svelte()],
  server: {
    port: 5173,
    proxy: { "/api": "http://127.0.0.1:9999" },
  },
  build: {
    outDir: "../public",
    emptyOutDir: true,
  },
});
