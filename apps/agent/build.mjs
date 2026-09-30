/**
 * Bundles the CLI to a single executable file.
 *
 * The createRequire banner exists because `qrcode` is CommonJS and reaches for
 * `fs` through a dynamic require that esbuild cannot resolve statically. With
 * a real `require` in scope, esbuild's interop shim delegates to it instead of
 * throwing. Without this the bundle dies on startup.
 */

import { build } from "esbuild";
import { buildId, releasesUrl } from "../../scripts/build-id.mjs";

await build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/clipsync.mjs",
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  define: {
    __CLIPSYNC_BUILD__: JSON.stringify(buildId()),
    __CLIPSYNC_RELEASES__: JSON.stringify(releasesUrl()),
  },
  banner: {
    js: [
      "#!/usr/bin/env node",
      `import { createRequire as __createRequire } from "node:module";`,
      `const require = __createRequire(import.meta.url);`,
    ].join("\n"),
  },
});
