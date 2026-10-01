/**
 * Builds `clipsync` as a standalone executable: a Node single executable
 * application (SEA), so a machine needs no Node, npm or checkout to run it.
 *
 *   node build-binary.mjs                      this machine's OS and CPU
 *   node build-binary.mjs --node <path> --target <os-arch>
 *                                              another target, given that
 *                                              target's own node binary
 *
 * Output: dist/bin/<os-arch>/clipsync (clipsync.exe on Windows), where
 * <os-arch> is one of linux-x64, linux-arm64, darwin-x64, darwin-arm64,
 * windows-x64.
 *
 * Steps: bundle the CLI as CommonJS (a SEA's entry script cannot be an ES
 * module on Node 22), turn it into a blob with `node --experimental-sea-config`,
 * copy a node binary, and inject the blob into it with postject. macOS kills
 * an arm64 binary whose signature does not match, so there the copy is
 * unsigned before the injection and signed ad hoc after it.
 *
 * The binary carries the server for `clipsync serve` with the web UI built
 * in, so apps/web/dist must be built first (`npm run build:binary` at the
 * root does that; decisions §40).
 *
 * The blob holds no snapshot or code cache, which keeps it independent of
 * the platform that built it. It must still be built by the same Node
 * version as the binary it goes into, so --node must be that version.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { build } from "esbuild";
import { inject } from "postject";
import { buildId, releasesUrl } from "../../scripts/build-id.mjs";
import { serverModules, webDist } from "../server/build-plugin.mjs";

/** The fuse Node looks for to know a blob was injected; fixed by Node. */
const SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

const OS_NAMES = { linux: "linux", darwin: "darwin", win32: "windows" };

const { values } = parseArgs({
  options: {
    node: { type: "string" },
    target: { type: "string" },
  },
});

// A release without the web UI would serve only the API, and say nothing.
if (!existsSync(join(webDist, "index.html"))) {
  throw new Error("apps/web/dist is not built: run `npm run build -w @clipsync/web` first");
}

const nativeTarget = `${OS_NAMES[process.platform] ?? process.platform}-${process.arch}`;
if (values.node && !values.target) throw new Error("--node needs --target <os-arch> to say what it is");
const nodeBinary = resolve(values.node ?? process.execPath);
const target = values.target ?? nativeTarget;
const [os] = target.split("-");
if (!["linux", "darwin", "windows"].includes(os)) throw new Error(`unknown target ${target}`);

const work = resolve("dist/sea");
const outDir = resolve("dist/bin", target);
const out = join(outDir, os === "windows" ? "clipsync.exe" : "clipsync");
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
mkdirSync(outDir, { recursive: true });

// The same bundle as build.mjs, as CommonJS. A SEA's `require` loads only
// built-in modules, which is all a fully bundled script asks for -- qrcode's
// dynamic require("fs") included. import.meta.url does not exist in
// CommonJS; the CLI asks for it only when it is not a SEA.
const script = join(work, "clipsync.cjs");
await build({
  entryPoints: ["src/cli.ts"],
  outfile: script,
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  define: {
    __CLIPSYNC_BUILD__: JSON.stringify(buildId()),
    __CLIPSYNC_RELEASES__: JSON.stringify(releasesUrl()),
    "import.meta.url": "undefined",
  },
  // ws loads these optional native speedups inside try/catch.
  external: ["bufferutil", "utf-8-validate"],
  plugins: [serverModules()],
  logLevel: "warning",
});

const blob = join(work, "clipsync.blob");
const config = join(work, "sea-config.json");
writeFileSync(
  config,
  JSON.stringify({
    main: script,
    output: blob,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
  }),
);
execFileSync(process.execPath, ["--experimental-sea-config", config], { stdio: "inherit" });

rmSync(out, { force: true });
copyFileSync(nodeBinary, out);
chmodSync(out, 0o755);
if (os === "darwin") execFileSync("codesign", ["--remove-signature", out], { stdio: "inherit" });

await inject(out, "NODE_SEA_BLOB", readFileSync(blob), {
  sentinelFuse: SEA_FUSE,
  ...(os === "darwin" ? { machoSegmentName: "NODE_SEA" } : {}),
});

if (os === "darwin") execFileSync("codesign", ["--sign", "-", out], { stdio: "inherit" });

console.log(`built ${out} (${target}, Node ${process.version})`);
