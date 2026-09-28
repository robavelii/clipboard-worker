import { describe, expect, it } from "vitest";
import type { VaultKeyResponse } from "@clipsync/protocol";
import { api, bootstrap } from "./helpers";

const WRAPPED = "k1.aXYtaXYtaXYtaXY.Y2lwaGVydGV4dA";

describe("GET /api/vault/key", () => {
  it("requires a device token", async () => {
    expect((await api("/api/vault/key")).status).toBe(401);
  });

  it("starts empty on a new account, with the account's salt", async () => {
    const device = await bootstrap();
    const res = await api("/api/vault/key", { token: device.token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as VaultKeyResponse;
    expect(body.kdfSalt).toBe(device.kdfSalt);
    expect(body.wrappedVaultKey).toBeNull();
  });
});

describe("PUT /api/vault/key", () => {
  it("stores a k1 envelope and hands it back", async () => {
    const device = await bootstrap();
    const put = await api("/api/vault/key", {
      method: "PUT",
      token: device.token,
      body: { wrappedVaultKey: WRAPPED },
    });
    expect(put.status).toBe(200);

    const got = (await (
      await api("/api/vault/key", { token: device.token })
    ).json()) as VaultKeyResponse;
    expect(got.wrappedVaultKey).toBe(WRAPPED);
  });

  it.each([
    ["missing", {}],
    ["not a k1 envelope", { wrappedVaultKey: "v1.not.a.wrapped.key" }],
    ["oversized", { wrappedVaultKey: `k1.${"a".repeat(600)}` }],
  ])("refuses a key that is %s", async (_label, body) => {
    const device = await bootstrap();
    const res = await api("/api/vault/key", {
      method: "PUT",
      token: device.token,
      body,
    });
    expect(res.status).toBe(400);
  });

  it("requires a device token", async () => {
    const res = await api("/api/vault/key", {
      method: "PUT",
      body: { wrappedVaultKey: WRAPPED },
    });
    expect(res.status).toBe(401);
  });
});
