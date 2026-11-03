/**
 * Renaming devices and reading the plan (GET /api/account/plan): both act
 * only within the calling device's own account.
 */

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { AccountPlan, Credentials, Device, PairCodeResponse } from "@clipsync/protocol";
import { sha256 } from "../src/ids";
import { api, bootstrap } from "./helpers";

async function otherAccount(): Promise<Credentials> {
  const userId = `usr_o${crypto.randomUUID().slice(0, 8)}`;
  const deviceId = `dev_o${crypto.randomUUID().slice(0, 8)}`;
  const token = `tok_o${crypto.randomUUID()}`;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (id, kdf_salt, wrapped_vault_key, created_at) VALUES (?, ?, ?, ?)").bind(
      userId,
      "salt-of-o",
      "k1.wrapped-for-o",
      Date.now() + 1,
    ),
    env.DB.prepare(
      "INSERT INTO devices (id, user_id, name, platform, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(deviceId, userId, "o-laptop", "linux", await sha256(token), Date.now()),
  ]);
  return { userId, deviceId, token, kdfSalt: "salt-of-o", wrappedVaultKey: "k1.wrapped-for-o", keyEpoch: 0 };
}

async function names(who: Credentials): Promise<string[]> {
  const { devices } = (await (await api("/api/devices", { token: who.token })).json()) as { devices: Device[] };
  return devices.map((d) => d.name);
}

describe("renaming a device", () => {
  it("renames this device and another of the account's, trimmed", async () => {
    const owner = await bootstrap("old-name");
    const { code } = (await (await api("/api/devices/pair-code", { method: "POST", token: owner.token })).json()) as PairCodeResponse;
    const phone = (await (
      await api("/api/devices/pair", { method: "POST", body: { code, deviceName: "phone", platform: "ios" } })
    ).json()) as Credentials;

    const self = await api(`/api/devices/${owner.deviceId}`, { method: "PATCH", token: owner.token, body: { name: "  laptop " } });
    expect(self.status).toBe(200);
    expect(await self.json()).toEqual({ ok: true, name: "laptop" });
    expect((await api(`/api/devices/${phone.deviceId}`, { method: "PATCH", token: owner.token, body: { name: "work phone" } })).status).toBe(200);

    expect(await names(owner)).toEqual(expect.arrayContaining(["laptop", "work phone"]));
  });

  it("refuses an empty or overlong name", async () => {
    const owner = await bootstrap();
    for (const name of ["", "   ", "x".repeat(65), 42]) {
      expect((await api(`/api/devices/${owner.deviceId}`, { method: "PATCH", token: owner.token, body: { name } })).status).toBe(400);
    }
  });

  it("cannot reach another account's device, or a revoked one", async () => {
    const owner = await bootstrap();
    const other = await otherAccount();
    const res = await api(`/api/devices/${other.deviceId}`, { method: "PATCH", token: owner.token, body: { name: "mine now" } });
    expect(res.status).toBe(404);
    expect(await names(other)).toEqual(["o-laptop"]);

    const { code } = (await (await api("/api/devices/pair-code", { method: "POST", token: owner.token })).json()) as PairCodeResponse;
    const gone = (await (
      await api("/api/devices/pair", { method: "POST", body: { code, deviceName: "gone", platform: "linux" } })
    ).json()) as Credentials;
    await api(`/api/devices/${gone.deviceId}`, { method: "DELETE", token: owner.token });
    expect((await api(`/api/devices/${gone.deviceId}`, { method: "PATCH", token: owner.token, body: { name: "back" } })).status).toBe(404);
  });
});

describe("the account's plan", () => {
  it("reports the plan's limits and the active devices", async () => {
    const owner = await bootstrap();
    await env.DB.prepare("UPDATE users SET plan = 'free' WHERE id = ?").bind(owner.userId).run();
    const plan = (await (await api("/api/account/plan", { token: owner.token })).json()) as AccountPlan;
    expect(plan).toMatchObject({ name: "free", maxDevices: 2, textTtlDays: 3, fileTtlDays: 1, files: false, maxPins: 10, pins: 0 });
    expect(plan.devices).toBeGreaterThanOrEqual(1);
    expect(plan.storageBytes).toBe(10 * 1024 * 1024);
  });

  it("counts only the caller's own account", async () => {
    const other = await otherAccount();
    const plan = (await (await api("/api/account/plan", { token: other.token })).json()) as AccountPlan;
    expect(plan.devices).toBe(1);
    expect(plan.maxDevices).toBeNull();
  });
});
