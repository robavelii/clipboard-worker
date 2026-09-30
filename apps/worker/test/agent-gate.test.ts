import { SELF } from "cloudflare:test";
import { AGENT_OUTDATED_ERROR, AGENT_VERSION_HEADER } from "@clipsync/protocol";
import { describe, expect, it } from "vitest";
import { bootstrap } from "./helpers";

// MIN_AGENT_VERSION is v0.5.0 in the tests (vitest.config.ts).
describe("agent gate", () => {
  const call = (method: string, token: string, agent?: string) =>
    SELF.fetch("https://clip.test/api/clips", {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(agent ? { [AGENT_VERSION_HEADER]: agent } : {}),
      },
      // Invalid on purpose: past the gate, the route answers 400.
      body: method === "GET" ? undefined : "{}",
    });

  it("refuses writes from a release older than the minimum", async () => {
    const { token } = await bootstrap("old-agent");
    const res = await call("POST", token, "v0.4.9");
    expect(res.status).toBe(426);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe(AGENT_OUTDATED_ERROR);
    expect(body.message).toContain("v0.5.0");
  });

  it("still lets an old release read", async () => {
    const { token } = await bootstrap("old-reader");
    expect((await call("GET", token, "v0.4.9")).status).toBe(200);
  });

  it("still lets an old release connect, and log out", async () => {
    const { token } = await bootstrap("old-listener");
    const headers = { authorization: `Bearer ${token}`, [AGENT_VERSION_HEADER]: "v0.4.9" };
    const ticket = await SELF.fetch("https://clip.test/api/sync/ticket", { method: "POST", headers });
    expect(ticket.status).toBe(200);
    const logout = await SELF.fetch("https://clip.test/api/devices/me", { method: "DELETE", headers });
    expect(logout.status).toBe(200);
  });

  it.each([
    ["the minimum itself", "v0.5.0"],
    ["a newer release", "v1.0.0"],
    ["a build from a checkout", "e7f8cb9-dirty"],
    ["a client that names no build", undefined],
  ])("lets %s write", async (_, agent) => {
    const { token } = await bootstrap("writer");
    expect((await call("POST", token, agent)).status).toBe(400);
  });
});
