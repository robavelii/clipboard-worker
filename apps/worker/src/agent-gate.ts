/**
 * Refuse writes from agent releases older than MIN_AGENT_VERSION
 * (decisions §34).
 *
 * The one thing an agent too old to understand a change could do wrong is
 * write: a clip in a format others no longer read, say. Reading is left
 * alone, and so is keeping in touch (see HARMLESS), so it still receives
 * other devices' copies and learns that it must update. The
 * gate only applies to agents that name a release: browsers, the tray and
 * builds from a checkout send no release tag and are never turned away.
 */

import { createMiddleware } from "hono/factory";
import {
  AGENT_OUTDATED_ERROR,
  AGENT_VERSION_HEADER,
  isOlderRelease,
  type ApiError,
} from "@clipsync/protocol";

const READS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Requests that change something but write nothing another device reads,
 * so an outdated agent can still connect, receive, pick up a re-key and log
 * out: the socket ticket, its own public key, and its own revocation.
 */
const HARMLESS = new Set([
  "POST /api/sync/ticket",
  "PUT /api/devices/me/key",
  "DELETE /api/devices/me",
]);

export const agentGate = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const agent = c.req.header(AGENT_VERSION_HEADER);
  const minimum = c.env.MIN_AGENT_VERSION;
  const request = `${c.req.method} ${c.req.path}`;
  if (agent && !READS.has(c.req.method) && !HARMLESS.has(request) && isOlderRelease(agent, minimum)) {
    return c.json<ApiError>(
      {
        error: AGENT_OUTDATED_ERROR,
        message: `this agent (${agent}) is older than ${minimum}, the oldest this server accepts writes from -- update it`,
      },
      426,
    );
  }
  await next();
});
