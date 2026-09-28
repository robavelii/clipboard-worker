// The migrations read by vitest.config.ts, handed to the tests as a binding.
declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
    /**
     * Set by vitest.config.ts. `wrangler types` only adds it when a local
     * .dev.vars exists, so CI would otherwise not see it on the test env.
     */
    ADMIN_SECRET: string;
  }
}
