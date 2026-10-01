/**
 * `clipsync-server`: run ClipSync's server on this machine.
 *
 *   node dist/clipsync-server.mjs [--data <dir>] [--listen <host:port>]
 *                                 [--web <dir>] [--trust-proxy] [--storage <bytes>]
 *
 * The options are serve.ts's; the standalone binary runs the same server as
 * `clipsync serve`. This entry serves the web UI copied next to it by the
 * build, unless --web names another.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "./serve";

function defaultWebDir(): string | null {
  const here = typeof import.meta.url === "string" ? fileURLToPath(new URL("./web/", import.meta.url)) : null;
  return here && existsSync(join(here, "index.html")) ? here : null;
}

serve(process.argv.slice(2), { command: "node clipsync-server.mjs", web: defaultWebDir() }).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
