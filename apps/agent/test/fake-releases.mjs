/**
 * A stand-in for a repo's GitHub releases, as the updater uses them, for
 * testing `clipsync update` against local files (the Release workflow does):
 *
 *   node fake-releases.mjs <dir> <tag> <port>
 *
 * GET /releases/latest                   302 to /releases/tag/<tag>
 * GET /releases/download/<tag>/<file>    <dir>/<file>
 *
 * Point an agent at it with CLIPSYNC_RELEASES=http://127.0.0.1:<port>/releases.
 */

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, join } from "node:path";

const [dir, tag, port] = process.argv.slice(2);
if (!dir || !tag || !port) {
  console.error("usage: node fake-releases.mjs <dir> <tag> <port>");
  process.exit(2);
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  if (url.pathname === "/releases/latest") {
    res.writeHead(302, { location: `http://127.0.0.1:${port}/releases/tag/${tag}` }).end();
    return;
  }
  const prefix = `/releases/download/${tag}/`;
  if (url.pathname.startsWith(prefix)) {
    try {
      res.end(await readFile(join(dir, basename(url.pathname))));
    } catch {
      res.writeHead(404).end();
    }
    return;
  }
  res.writeHead(404).end();
}).listen(Number(port), "127.0.0.1", () => console.log(`releases of ${tag} from ${dir} on :${port}`));
