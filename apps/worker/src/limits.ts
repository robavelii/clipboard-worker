/**
 * Per-address rate limits for the endpoints that must work without a token.
 *
 * Keyed by CF-Connecting-IP, which Cloudflare sets on every request that
 * reaches the Worker and which a client cannot override. It is absent only in
 * local development, where limiting is skipped so the e2e suite and repeated
 * manual runs are unaffected.
 */

import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";

type LimiterName = "STRICT_LIMIT" | "UNAUTH_LIMIT";

export function clientAddress(req: { header(name: string): string | undefined }): string | null {
  return req.header("cf-connecting-ip") ?? null;
}

/**
 * Refuse with 429 once an address exceeds `limiter`'s budget for `scope`.
 * Scopes keep budgets apart, so guessing pair codes does not also spend the
 * address's allowance for link requests.
 */
export function rateLimit(limiter: LimiterName, scope: string) {
  return createMiddleware<{ Bindings: Env }>(async (c, next) => {
    const address = clientAddress(c.req);
    if (address) {
      const { success } = await c.env[limiter].limit({ key: `${scope}:${address}` });
      if (!success) {
        throw new HTTPException(429, {
          message: "too many attempts from this address -- try again in a minute",
        });
      }
    }
    await next();
  });
}
