/**
 * Worker unit tests run inside workerd itself, against the real Worker entry
 * and a fresh D1 database per test file with every migration applied -- the
 * same runtime and schema as production, without a separate dev server.
 */

import path from "node:path";
import { defineConfig } from "vitest/config";
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(
    path.join(import.meta.dirname, "migrations"),
  );

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          // The pool bundles its own workerd, which trails wrangler's and
          // refuses wrangler.jsonc's newer compatibility_date. Pin the tests
          // to the newest date that binary supports; bump it when the pool
          // catches up.
          compatibilityDate: "2026-08-22",
          bindings: {
            ADMIN_SECRET: "test-admin-secret",
            TEST_MIGRATIONS: migrations,
          },
        },
      }),
    ],
    test: {
      include: ["test/**/*.test.ts"],
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
