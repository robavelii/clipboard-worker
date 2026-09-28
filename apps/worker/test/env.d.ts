// The migrations read by vitest.config.ts, handed to the tests as a binding.
declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
