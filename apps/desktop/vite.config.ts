import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri serves this from disk in release and from the dev server in dev.
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
  clearScreen: false,
  server: { strictPort: true },
});
