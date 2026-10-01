/**
 * ClipSync Worker: REST API, sync WebSocket, static web UI and the expiry cron.
 *
 * The Worker is deliberately a dumb pipe for clipboard content. It sees
 * ciphertext envelopes and HMAC dedupe tags, never plaintext and never a key.
 */

import { app } from "./app";
import { purgeExpired } from "./purge";

export { SyncRoom } from "./sync-room";

export default {
  fetch: app.fetch,

  /** Hourly purge; see purge.ts. */
  async scheduled(_controller, env, _ctx): Promise<void> {
    console.log({ msg: "purged expired rows", ...(await purgeExpired(env, Date.now())) });
  },
} satisfies ExportedHandler<Env>;
