import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("installers", () => {
  it.each(["/install.sh", "/install.ps1"])("serves %s filled in with this origin and the releases repo", async (path) => {
    const res = await SELF.fetch(`https://clip.example.org${path}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    const body = await res.text();
    expect(body).toContain("https://clip.example.org");
    expect(body).toContain("robavelii/clipboard-worker");
    expect(body).not.toMatch(/__CLIPSYNC_[A-Z]+__/);
  });

  it("serves the shell installer as a script sh can run", async () => {
    const body = await (await SELF.fetch("https://clip.example.org/install.sh")).text();
    expect(body.startsWith("#!/bin/sh\n")).toBe(true);
    // Everything in main(), called last: a truncated download runs nothing.
    expect(body.trimEnd().endsWith('main "$@"')).toBe(true);
  });
});
