/**
 * The esbuild plugin every bundle of the server is built with: this
 * workspace's build.mjs, and the `clipsync` agent's two builds, which carry
 * the server for `clipsync serve` (decisions §40). It supplies:
 *
 *   clipsync:worker-app     the Worker's Hono app (apps/worker/src/app.ts)
 *   clipsync:worker-inputs  { vars, limits, migrations } (worker-inputs.mjs)
 *   clipsync:web-files      the built web UI as bytes, or null without one
 *   *.sh, *.ps1             the installers the Worker serves, as text
 *
 * vitest.config.ts supplies the first two the same way for the tests.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { workerAppPath, workerInputsModule } from "./worker-inputs.mjs";

export const webDist = fileURLToPath(new URL("../web/dist/", import.meta.url));

/** Every file under dir, as paths relative to it. */
function walk(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)));
}

/**
 * The `clipsync:web-files` module's source: each file of the built web UI,
 * keyed "/path", decoded from base64 when the module first loads.
 */
export function webFilesModule(dir = webDist) {
  if (!existsSync(join(dir, "index.html"))) return "export default null;";
  const entries = walk(dir)
    .sort()
    .map((file) => {
      const key = "/" + file.split(sep).join("/");
      return `  ${JSON.stringify(key)}: b(${JSON.stringify(readFileSync(join(dir, file)).toString("base64"))}),`;
    });
  return [
    'const b = (s) => new Uint8Array(Buffer.from(s, "base64"));',
    "export default {",
    ...entries,
    "};",
  ].join("\n");
}

export function serverModules() {
  return {
    name: "clipsync-server-modules",
    setup(b) {
      b.onResolve({ filter: /^clipsync:worker-app$/ }, () => ({ path: workerAppPath }));
      b.onResolve({ filter: /^clipsync:(worker-inputs|web-files)$/ }, (args) => ({
        path: args.path.slice("clipsync:".length),
        namespace: "clipsync",
      }));
      b.onLoad({ filter: /^worker-inputs$/, namespace: "clipsync" }, () => ({
        contents: workerInputsModule(),
        loader: "js",
      }));
      b.onLoad({ filter: /^web-files$/, namespace: "clipsync" }, () => ({
        contents: webFilesModule(),
        loader: "js",
        watchDirs: [webDist],
      }));
      b.onLoad({ filter: /\.(sh|ps1)$/ }, (args) => ({ contents: readFileSync(args.path, "utf8"), loader: "text" }));
    },
  };
}
