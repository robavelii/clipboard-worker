/**
 * The web UI served from files the build carries (the standalone binary's
 * `clipsync serve`), held to the same rules as a directory: the CSP from
 * `_headers` on every page, `_headers` itself never served, the SPA
 * fallback, and ETags.
 */

import { describe, expect, it } from "vitest";
import { StaticAssets, type WebFiles } from "../src/assets";

const text = (s: string) => new Uint8Array(Buffer.from(s));

const files: WebFiles = {
  "/index.html": text("<!doctype html><title>clipsync</title>"),
  "/_headers": text("/*\n  Content-Security-Policy: default-src 'self'\n"),
  "/assets/app.js": text("console.log(1)"),
};

const get = (assets: StaticAssets, path: string, headers: Record<string, string> = {}) =>
  assets.serve(new Request(`http://localhost${path}`, { headers }));

describe("StaticAssets.fromFiles", () => {
  const assets = StaticAssets.fromFiles(files);

  it("serves a file with its type and the _headers rules", async () => {
    const res = await get(assets, "/assets/app.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'self'");
    expect(await res.text()).toBe("console.log(1)");
  });

  it("answers any other path with index.html, and never serves _headers", async () => {
    for (const path of ["/share", "/_headers", "/assets/../_headers", "/%E0%A4%A"]) {
      const res = await get(assets, path);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await res.text()).toContain("<title>clipsync</title>");
    }
  });

  it("answers a matching If-None-Match with 304", async () => {
    const first = await get(assets, "/index.html");
    const etag = first.headers.get("etag")!;
    expect((await get(assets, "/index.html", { "if-none-match": etag })).status).toBe(304);
  });

  it("refuses a build without index.html", () => {
    expect(() => StaticAssets.fromFiles({ "/assets/app.js": text("") })).toThrow(/index\.html/);
  });
});
