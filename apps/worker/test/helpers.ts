import { SELF } from "cloudflare:test";
import type { Credentials } from "@clipsync/protocol";

export const ADMIN_SECRET = "test-admin-secret";

/** A request to the Worker under test, JSON in and out. */
export async function api(
  path: string,
  init: { method?: string; token?: string; body?: unknown; raw?: Uint8Array; ip?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": init.raw ? "application/octet-stream" : "application/json",
  };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  // Cloudflare sets this on every production request; locally it is absent
  // unless a test stands in for a client address.
  if (init.ip) headers["cf-connecting-ip"] = init.ip;
  return SELF.fetch(`https://clip.test${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
  });
}

/** Enrol a device with the admin secret, creating the account if needed. */
export async function bootstrap(deviceName = "test-device"): Promise<Credentials> {
  const res = await api("/api/auth/bootstrap", {
    method: "POST",
    body: { adminSecret: ADMIN_SECRET, deviceName, platform: "linux" },
  });
  if (!res.ok) throw new Error(`bootstrap failed: ${res.status}`);
  return (await res.json()) as Credentials;
}

/** A client address no other test uses, so rate-limit budgets never collide. */
let addressCounter = 0;
export function freshAddress(): string {
  addressCounter += 1;
  return `198.51.${Math.floor(Math.random() * 200)}.${addressCounter}`;
}

/**
 * A v2 envelope as the server sees it: a readable header naming `device`,
 * then an IV and ciphertext the server cannot check.
 */
export function v2Envelope(device: string, type = "text", tag = "x"): string {
  const header = btoa(JSON.stringify({ d: device, t: Date.now(), k: type }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `v2.${header}.aXYtaXYtaXYtaXY.${tag}`;
}
