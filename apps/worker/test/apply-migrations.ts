import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach } from "vitest";

// Storage is isolated per test file, not per test.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// A deployment serves one account, and the first bootstrap creates it, so a
// test that left one behind would change what the next test's bootstrap does.
// Start every test from an empty database instead.
beforeEach(async () => {
  await env.DB.batch(
    [
      "clips",
      "blob_chunks",
      "blobs",
      "r2_usage",
      "sealed_vault_keys",
      "devices",
      "pair_codes",
      "sync_tickets",
      "link_requests",
      "invites",
      "users",
    ].map((table) => env.DB.prepare(`DELETE FROM ${table}`)),
  );
  // R2 persists across tests the same way.
  const { objects } = await env.BLOBS.list();
  if (objects.length) await env.BLOBS.delete(objects.map((o) => o.key));
});
