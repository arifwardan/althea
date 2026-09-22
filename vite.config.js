import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// Dashboard Althea: dev `npm run dev:web` (5173, proxy /api → :3000),
// build `npm run build:web` → public/ (disajikan backend http bawaan).
export default defineConfig({
  root: "web",
  plugins: [svelte()],
  server: {
    port: 5173,
    proxy: { "/api": "http://127.0.0.1:3000" },
  },
  build: {
    outDir: "../public",
    emptyOutDir: true,
  },
});
