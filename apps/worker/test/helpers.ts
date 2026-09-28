import { SELF } from "cloudflare:test";
import type { Credentials } from "@clipsync/protocol";

export const ADMIN_SECRET = "test-admin-secret";

/** A request to the Worker under test, JSON in and out. */
export async function api(
  path: string,
  init: { method?: string; token?: string; body?: unknown } = {},
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  return SELF.fetch(`https://clip.test${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
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
