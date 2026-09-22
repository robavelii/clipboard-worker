import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    // Served by the Worker's assets binding (see apps/worker/wrangler.jsonc).
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    // `vite dev` runs on a different port than `wrangler dev`; proxying keeps
    // the app same-origin so the production code path is the only code path.
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
