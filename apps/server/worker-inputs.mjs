/**
 * What the server takes from the Worker at build time, so the two cannot
 * drift: the vars and rate limits in wrangler.jsonc, and the D1 migrations.
 *
 * Exposed to the server's code as two modules, resolved by the esbuild
 * plugin in build.mjs and the Vite plugin in vitest.config.ts:
 *
 *   clipsync:worker-app     the Worker's Hono app (apps/worker/src/app.ts)
 *   clipsync:worker-inputs  { vars, limits, migrations }
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const workerDir = fileURLToPath(new URL("../worker/", import.meta.url));

export const workerAppPath = `${workerDir}src/app.ts`;

/** Strips // and /* *\/ comments and trailing commas outside strings. */
function parseJsonc(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

export function workerInputs() {
  const wrangler = parseJsonc(readFileSync(`${workerDir}wrangler.jsonc`, "utf8"));
  const limits = Object.fromEntries(
    (wrangler.ratelimits ?? []).map((r) => [r.name, { limit: r.simple.limit, period: r.simple.period }]),
  );
  const dir = `${workerDir}${wrangler.d1_databases[0].migrations_dir}/`;
  const migrations = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, sql: readFileSync(dir + name, "utf8") }));
  return { vars: wrangler.vars ?? {}, limits, migrations };
}

/** The `clipsync:worker-inputs` module's source. */
export function workerInputsModule() {
  return `export default ${JSON.stringify(workerInputs())};`;
}
