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
      "account_usage",
      "sealed_vault_keys",
      "devices",
      "pair_codes",
      "sync_tickets",
      "link_requests",
      "invites",
      "email_codes",
      "deletion_codes",
      "email_changes",
      "signup_invites",
      "users",
    ].map((table) => env.DB.prepare(`DELETE FROM ${table}`)),
  );
  // Plans are seeded by migration; a test that changed one puts it back.
  await env.DB.prepare(
    `UPDATE plans SET max_devices = 3, text_ttl_days = 7, file_ttl_days = 7, files = 0,
            storage_bytes = 52428800, class_a = 2000, class_b = 20000 WHERE name = 'free'`,
  ).run();
  // R2 persists across tests the same way.
  const { objects } = await env.BLOBS.list();
  if (objects.length) await env.BLOBS.delete(objects.map((o) => o.key));
});
