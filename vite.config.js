import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";

// Dashboard Althea: dev `npm run dev:web` (5173, proxy /api → :9000),
// build `npm run build:web` → public/ (disajikan backend http bawaan).
// Tailwind dipakai TANPA preflight (lihat web/src/tailwind.css) agar
// reset global tidak mengubah halaman lama yang masih memakai app.css.
export default defineConfig({
  root: "web",
  plugins: [tailwindcss(), svelte()],
  resolve: {
    alias: {
      $lib: fileURLToPath(new URL("./web/src/lib", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // diakses publik via Caddy sebagai https://althea.test
    allowedHosts: ["althea.test"],
    proxy: { "/api": "http://127.0.0.1:9000" },
  },
  build: {
    outDir: "../public",
    emptyOutDir: true,
  },
});
