/**
 * ClipSync Worker: REST API, sync WebSocket, static web UI and the expiry cron.
 *
 * The Worker is deliberately a dumb pipe for clipboard content. It sees
 * ciphertext envelopes and HMAC dedupe tags, never plaintext and never a key.
 */

import { connect } from "cloudflare:sockets";
import { app } from "./app";
import { mailerFor, type Connect } from "./mail";
import { purgeExpired } from "./purge";

export { SyncRoom } from "./sync-room";

/** SMTP over TLS from the first byte, on Cloudflare's TCP sockets. */
const tlsConnect: Connect = (hostname, port) => connect({ hostname, port }, { secureTransport: "on", allowHalfOpen: false });

export default {
  fetch: (request, env, ctx) => app.fetch(request, { ...env, MAILER: mailerFor(env, tlsConnect) }, ctx),

  /** Hourly purge; see purge.ts. */
  async scheduled(_controller, env, _ctx): Promise<void> {
    console.log({ msg: "purged expired rows", ...(await purgeExpired(env, Date.now())) });
  },
} satisfies ExportedHandler<Env>;
