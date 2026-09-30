/**
 * The one-command installers (decisions §33):
 *
 *   curl -fsSL https://<this worker>/install.sh | sh
 *   irm https://<this worker>/install.ps1 | iex
 *
 * The scripts live in scripts/ and are bundled as text. They are served with
 * this Worker's own origin filled in, so a device installed from here links
 * back to here, whichever domain that is; and with the repo whose GitHub
 * releases hold the binaries (the RELEASES_REPO var).
 *
 * Plain text, never cached for long: an installer is fetched rarely and
 * should always be the current one.
 */

import { Hono, type Context } from "hono";
import installPs1 from "../../../../scripts/install.ps1";
import installSh from "../../../../scripts/install.sh";

function script(c: Context<{ Bindings: Env }>, template: string) {
  const body = template
    .replaceAll("__CLIPSYNC_URL__", new URL(c.req.url).origin)
    .replaceAll("__CLIPSYNC_REPO__", c.env.RELEASES_REPO);
  return c.body(body, 200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
  });
}

export const installRoutes = new Hono<{ Bindings: Env }>()
  .get("/install.sh", (c) => script(c, installSh))
  .get("/install.ps1", (c) => script(c, installPs1));
