import { describe, expect, it } from "vitest";
import { ADMIN_SECRET, api, bootstrap, freshAddress } from "./helpers";

/** Raw P-256 point, base64url: the shape /link/request validates. */
function publicKey(n: number): string {
  return `B${String(n).padStart(4, "0")}${"A".repeat(82)}`;
}

describe("rate limits (audit O4)", () => {
  it("allows five bootstrap attempts a minute per address, then refuses", async () => {
    const ip = freshAddress();
    const attempt = () =>
      api("/api/auth/bootstrap", {
        method: "POST",
        ip,
        body: { adminSecret: "a guess", deviceName: "guesser", platform: "linux" },
      });

    for (let i = 0; i < 5; i++) expect((await attempt()).status).toBe(403);
    expect((await attempt()).status).toBe(429);

    // The right secret from that address is refused too, until the minute is up.
    const right = await api("/api/auth/bootstrap", {
      method: "POST",
      ip,
      body: { adminSecret: ADMIN_SECRET, deviceName: "owner", platform: "linux" },
    });
    expect(right.status).toBe(429);
  });

  it("keeps separate budgets per address", async () => {
    const noisy = freshAddress();
    for (let i = 0; i < 6; i++) {
      await api("/api/auth/bootstrap", {
        method: "POST",
        ip: noisy,
        body: { adminSecret: "a guess", deviceName: "guesser", platform: "linux" },
      });
    }
    const other = await api("/api/auth/bootstrap", {
      method: "POST",
      ip: freshAddress(),
      body: { adminSecret: ADMIN_SECRET, deviceName: "owner", platform: "linux" },
    });
    expect(other.status).toBe(200);
  });

  it("limits pair-code guessing", async () => {
    const ip = freshAddress();
    const guess = () =>
      api("/api/devices/pair", {
        method: "POST",
        ip,
        body: { code: "PAIR-AAAA-AAAA", deviceName: "guesser", platform: "linux" },
      });
    for (let i = 0; i < 10; i++) expect((await guess()).status).toBe(400);
    expect((await guess()).status).toBe(429);
  });

  it("does not limit requests that carry no client address (local dev)", async () => {
    for (let i = 0; i < 7; i++) {
      const res = await api("/api/auth/bootstrap", {
        method: "POST",
        body: { adminSecret: "a guess", deviceName: "guesser", platform: "linux" },
      });
      expect(res.status).toBe(403);
    }
  });

  // Local workerd fills the header in from the connection, so `wrangler dev`
  // and the e2e suite arrive as loopback. The edge never sends one.
  it("does not limit loopback addresses, as local workerd reports them", async () => {
    for (const ip of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      for (let i = 0; i < 7; i++) {
        const res = await api("/api/auth/bootstrap", {
          method: "POST",
          ip,
          body: { adminSecret: "a guess", deviceName: "guesser", platform: "linux" },
        });
        expect(res.status).toBe(403);
      }
    }
  });

  it("still limits an address that merely starts like loopback", async () => {
    // Limiter state outlives the test, so the address is new each run.
    const ip = `127.0.0.1.${Date.now()}`;
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await api("/api/auth/bootstrap", {
        method: "POST",
        ip,
        body: { adminSecret: "a guess", deviceName: "guesser", platform: "linux" },
      });
      statuses.push(res.status);
    }
    expect(statuses).toContain(429);
  });
});

describe("pending link requests (audit O4)", () => {
  const request = (ip: string, n: number) =>
    api("/api/link/request", {
      method: "POST",
      ip,
      body: { publicKey: publicKey(n), deviceName: `joiner-${n}`, platform: "linux" },
    });

  it("caps pending requests per address, not globally", async () => {
    const flooder = freshAddress();
    for (let i = 0; i < 3; i++) expect((await request(flooder, i)).status).toBe(200);
    expect((await request(flooder, 3)).status).toBe(429);

    // Before, 20 anonymous requests blocked `clipsync link` for everyone.
    expect((await request(freshAddress(), 4)).status).toBe(200);
  });
});

describe("invite proofs at rest (audit O9)", () => {
  const SEALED = "i1.aXYtaXYtaXYtaXY.c2VhbGVk";
  const PROOF = "cHJvb2YtcHJvb2YtcHJvb2YtcHJvb2YtcHJvb2YtcHJ";

  it("stores something other than what the claimant presents", async () => {
    const device = await bootstrap();
    const created = await api("/api/invites", {
      method: "POST",
      token: device.token,
      body: { sealedVaultKey: SEALED, proofHash: PROOF },
    });
    expect(created.status).toBe(200);
    const { inviteId } = (await created.json()) as { inviteId: string };

    const { env } = await import("cloudflare:workers");
    const row = await env.DB.prepare("SELECT proof_hash FROM invites WHERE id = ?")
      .bind(inviteId)
      .first<{ proof_hash: string }>();
    expect(row?.proof_hash).toBeTruthy();
    expect(row?.proof_hash).not.toBe(PROOF);

    // Someone who can read the table cannot claim with what they read...
    const withStored = await api(`/api/invites/${inviteId}/claim`, {
      method: "POST",
      body: { proof: row!.proof_hash, deviceName: "reader", platform: "other" },
    });
    expect(withStored.status).toBe(404);

    // ...while the scanning device, which presents the proof, still can.
    const scanned = await api(`/api/invites/${inviteId}/claim`, {
      method: "POST",
      body: { proof: PROOF, deviceName: "phone", platform: "other" },
    });
    expect(scanned.status).toBe(200);
  });
});
