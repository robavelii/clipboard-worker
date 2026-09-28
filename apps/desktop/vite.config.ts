import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { buildId } from "../../scripts/build-id.mjs";

// Tauri serves this from disk in release and from the dev server in dev.
export default defineConfig({
  plugins: [react()],
  define: { __CLIPSYNC_BUILD__: JSON.stringify(buildId()) },
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
  clearScreen: false,
  server: { strictPort: true },
});
