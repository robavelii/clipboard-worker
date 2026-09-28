/**
 * Secrets the Worker reads, declared by hand.
 *
 * `wrangler types` only learns about a secret from a local `.dev.vars`, which
 * is gitignored -- so without this, a fresh clone fails to typecheck on the
 * first `c.env.ADMIN_SECRET`. Merges with the generated `Env`; the modifiers
 * must match the generated declaration exactly.
 */
interface Env {
  /** Authorises the first device. `wrangler secret put ADMIN_SECRET`. */
  ADMIN_SECRET: string;
}
