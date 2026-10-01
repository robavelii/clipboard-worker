import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vitest/config";
// @ts-expect-error -- plain .mjs shared with build.mjs
import { workerAppPath, workerInputsModule } from "./worker-inputs.mjs";

/** The same `clipsync:` modules and text installers build.mjs gives esbuild. */
const workerModules: Plugin = {
  name: "clipsync-worker",
  enforce: "pre",
  resolveId(id) {
    if (id === "clipsync:worker-app") return workerAppPath;
    if (id === "clipsync:worker-inputs") return "\0clipsync:worker-inputs";
    return null;
  },
  load(id) {
    if (id === "\0clipsync:worker-inputs") return workerInputsModule();
    if (/\.(sh|ps1)$/.test(id)) return `export default ${JSON.stringify(readFileSync(id, "utf8"))};`;
    return null;
  },
};

export default defineConfig({
  plugins: [workerModules],
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 20_000,
  },
});
