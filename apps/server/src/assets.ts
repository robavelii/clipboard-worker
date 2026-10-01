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
 */

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

export class StaticAssets {
  private readonly root: string;
  private readonly rules: HeaderRule[];

  constructor(root: string) {
    this.root = resolve(root);
    let headers = "";
    try {
      headers = readFileSync(join(this.root, "_headers"), "utf8");
    } catch {
      // No rules file: plain files.
    }
    this.rules = parseHeaders(headers);
    statSync(join(this.root, "index.html")); // fail at startup, not on the first visit
  }

  async serve(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    const file = this.resolveFile(pathname) ?? join(this.root, "index.html");
    const stats = statSync(file);
    const etag = `W/"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`;
    const headers = new Headers({
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      "cache-control": "public, max-age=0, must-revalidate",
      etag,
    });
    for (const rule of this.rules) {
      if (!rule.pattern.test(pathname)) continue;
      for (const [name, value] of rule.headers) headers.set(name, value);
    }
    if (request.headers.get("if-none-match") === etag) {
      return new Response(null, { status: 304, headers });
    }
    const body = request.method === "HEAD" ? null : await readFile(file);
    headers.set("content-length", String(stats.size));
    return new Response(body, { status: 200, headers });
  }

  /** The file a path names, if it is one inside the root (and not `_headers`). */
  private resolveFile(pathname: string): string | null {
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return null;
    }
    if (decoded.includes("\0")) return null;
    const path = resolve(this.root, "." + decoded);
    if (path !== this.root && !path.startsWith(this.root + sep)) return null;
    if (path === join(this.root, "_headers")) return null;
    try {
      return statSync(path).isFile() ? path : null;
    } catch {
      return null;
    }
  }
}
