import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";

// Dashboard Althea: dev `npm run dev:web` (5173, proxy /api → :9999),
// build `npm run build:web` → public/ (disajikan backend http bawaan).
// Tailwind dipakai TANPA preflight (lihat web/src/tailwind.css) agar
// reset global tidak mengubah halaman lama yang masih memakai app.css.
export default defineConfig({
  root: "web",
  plugins: [tailwindcss(), svelte()],
  server: {
    port: 5173,
    proxy: { "/api": "http://127.0.0.1:9999" },
  },
  build: {
    outDir: "../public",
    emptyOutDir: true,
  },
});
