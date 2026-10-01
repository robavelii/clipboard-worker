/**
 * The web UI's static files, served the way Workers static assets serves
 * them (wrangler.jsonc `assets`):
 *
 *   - a path that names a file gets that file;
 *   - any other GET or HEAD gets index.html (single-page-application);
 *   - the rules in `_headers` apply to every asset response. They carry the
 *     CSP the web UI depends on, so a server that skipped them would serve
 *     the vault-holding page without its main defence.
 *
 * ETag and If-None-Match are honoured; everything else is revalidated on
 * each load, as Cloudflare does by default.
 *
 * The files come from a directory (apps/web/dist next to the server) or, in
 * the standalone `clipsync` binary, from the build itself (`WebFiles`).
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

interface HeaderRule {
  pattern: RegExp;
  headers: [string, string][];
}

/** Parses Cloudflare's `_headers` format: a path pattern, then indented `Name: value` lines. */
export function parseHeaders(text: string): HeaderRule[] {
  const rules: HeaderRule[] = [];
  let current: HeaderRule | null = null;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue;
    if (/^\s/.test(raw)) {
      const colon = raw.indexOf(":");
      if (current && colon > 0) {
        current.headers.push([raw.slice(0, colon).trim(), raw.slice(colon + 1).trim()]);
      }
      continue;
    }
    const source = raw
      .trim()
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/:[A-Za-z]\w*/g, "[^/]+");
    current = { pattern: new RegExp(`^${source}$`), headers: [] };
    rules.push(current);
  }
  return rules;
}

/** The built web UI as bytes, keyed by path from its root ("/index.html"). */
export type WebFiles = Record<string, Uint8Array<ArrayBuffer>>;

interface Asset {
  /** Its path, for the content type. */
  name: string;
  size: number;
  etag: string;
  read(): Promise<Uint8Array<ArrayBuffer>>;
}

/** The asset a decoded path names, or null; never `_headers`. */
type Lookup = (path: string) => Asset | null;

export class StaticAssets {
  private constructor(
    private readonly lookup: Lookup,
    private readonly rules: HeaderRule[],
  ) {
    // Fail at startup, not on the first visit.
    if (!lookup("/index.html")) throw new Error("the web UI has no index.html");
  }

  static fromDirectory(root: string): StaticAssets {
    const base = resolve(root);
    let headers = "";
    try {
      headers = readFileSync(join(base, "_headers"), "utf8");
    } catch {
      // No rules file: plain files.
    }
    const lookup: Lookup = (path) => {
      const file = resolve(base, "." + path);
      if (file !== base && !file.startsWith(base + sep)) return null;
      if (file === join(base, "_headers")) return null;
      try {
        const stats = statSync(file);
        if (!stats.isFile()) return null;
        return {
          name: file,
          size: stats.size,
          etag: `W/"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`,
          read: () => readFile(file),
        };
      } catch {
        return null;
      }
    };
    return new StaticAssets(lookup, parseHeaders(headers));
  }

  static fromFiles(files: WebFiles): StaticAssets {
    const assets = new Map<string, Asset>();
    for (const [name, bytes] of Object.entries(files)) {
      if (name === "/_headers") continue;
      const hash = createHash("sha256").update(bytes).digest("base64url").slice(0, 16);
      assets.set(name, { name, size: bytes.byteLength, etag: `W/"${hash}"`, read: async () => bytes });
    }
    const headers = files["/_headers"] ? new TextDecoder().decode(files["/_headers"]) : "";
    return new StaticAssets((path) => assets.get(path) ?? null, parseHeaders(headers));
  }

  async serve(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    const path = decodePath(pathname);
    const asset = (path && this.lookup(path)) || this.lookup("/index.html")!;
    const headers = new Headers({
      "content-type": TYPES[extname(asset.name)] ?? "application/octet-stream",
      "cache-control": "public, max-age=0, must-revalidate",
      etag: asset.etag,
    });
    for (const rule of this.rules) {
      if (!rule.pattern.test(pathname)) continue;
      for (const [name, value] of rule.headers) headers.set(name, value);
    }
    if (request.headers.get("if-none-match") === asset.etag) {
      return new Response(null, { status: 304, headers });
    }
    const body = request.method === "HEAD" ? null : await asset.read();
    headers.set("content-length", String(asset.size));
    return new Response(body, { status: 200, headers });
  }
}

/** A URL path decoded, or null if it does not decode or holds a NUL. */
function decodePath(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  return decoded.includes("\0") ? null : decoded;
}
