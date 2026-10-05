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
  /** OCI Email Delivery's SMTP credentials (decisions §45); mail is off without them. */
  SMTP_USER?: string;
  SMTP_PASSWORD?: string;
  /** `outbox` in the Worker tests: mail is kept in memory, not sent (mail.ts). */
  MAIL_MODE?: string;
  /** How the app sends mail, put on the env by the runtime's entry (index.ts, apps/server); null when not set up. */
  MAILER?: import("./mail").Mailer | null;
}
