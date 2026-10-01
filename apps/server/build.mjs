/**
 * Builds dist/clipsync-server.mjs: the Worker's app and the Node bindings in
 * one file, plus a copy of the built web UI in dist/web/ (build
 * @clipsync/web first). `node dist/clipsync-server.mjs` then needs nothing
 * else: no checkout, no npm install.
 */

import { cpSync, existsSync, rmSync } from "node:fs";
import { build } from "esbuild";
import { serverModules } from "./build-plugin.mjs";

rmSync("dist", { recursive: true, force: true });

await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/clipsync-server.mjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  // ws loads these optional native speedups inside try/catch.
  external: ["bufferutil", "utf-8-validate"],
  // Bundled CommonJS dependencies (ws) call require() for Node built-ins.
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
  plugins: [serverModules()],
  logLevel: "warning",
});

const web = "../web/dist";
if (existsSync(`${web}/index.html`)) {
  cpSync(web, "dist/web", { recursive: true });
} else {
  console.warn("apps/web/dist not built: the server will serve the API only (npm run build -w @clipsync/web)");
}
