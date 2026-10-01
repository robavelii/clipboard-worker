/**
 * Builds dist/clipsync-server.mjs: the Worker's app and the Node bindings in
 * one file, plus a copy of the built web UI in dist/web/ (build
 * @clipsync/web first). `node dist/clipsync-server.mjs` then needs nothing
 * else: no checkout, no npm install.
 */

import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { build } from "esbuild";
import { workerAppPath, workerInputsModule } from "./worker-inputs.mjs";

rmSync("dist", { recursive: true, force: true });

/** The `clipsync:` modules (worker-inputs.mjs) and the installers as text, as wrangler bundles them. */
const workerModules = {
  name: "clipsync-worker",
  setup(b) {
    b.onResolve({ filter: /^clipsync:worker-app$/ }, () => ({ path: workerAppPath }));
    b.onResolve({ filter: /^clipsync:worker-inputs$/ }, () => ({ path: "inputs", namespace: "clipsync" }));
    b.onLoad({ filter: /.*/, namespace: "clipsync" }, () => ({ contents: workerInputsModule(), loader: "js" }));
    b.onLoad({ filter: /\.(sh|ps1)$/ }, (args) => ({ contents: readFileSync(args.path, "utf8"), loader: "text" }));
  },
};

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
  plugins: [workerModules],
  logLevel: "warning",
});

const web = "../web/dist";
if (existsSync(`${web}/index.html`)) {
  cpSync(web, "dist/web", { recursive: true });
} else {
  console.warn("apps/web/dist not built: the server will serve the API only (npm run build -w @clipsync/web)");
}
