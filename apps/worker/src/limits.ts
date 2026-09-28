/**
 * Per-address rate limits for the endpoints that must work without a token.
 *
 * Keyed by CF-Connecting-IP, which Cloudflare sets on every request that
 * reaches the Worker and which a client cannot override. Local development
 * is not limited, so the e2e suite and repeated manual runs are unaffected:
 * there the header is absent (Worker tests) or a loopback address, which
 * local workerd fills in from the connection and which the edge never sends.
 */

import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";

type LimiterName = "STRICT_LIMIT" | "UNAUTH_LIMIT";

/** 127.0.0.0/8 and ::1, in the forms a runtime may write them. */
function isLoopback(address: string): boolean {
  const ip = address.trim().toLowerCase().replace(/^::ffff:/, "");
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip) || ip === "::1" || ip === "0:0:0:0:0:0:0:1";
}

/**
 * The client's address, or null for a request that did not come through the
 * edge: no header, or a loopback address. From the internet it is always a
 * real address, so this never exempts a real client.
 */
export function clientAddress(req: { header(name: string): string | undefined }): string | null {
  const address = req.header("cf-connecting-ip");
  return address && !isLoopback(address) ? address : null;
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
