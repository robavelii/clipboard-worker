/**
 * Real-time sync endpoint.
 *
 * A browser cannot attach an Authorization header to a WebSocket handshake,
 * and putting a long-lived device token in a query string leaks it into every
 * access log in the path. So: authenticate normally over HTTP, exchange the
 * token for a 30-second single-use ticket, and spend the ticket on the socket.
 */

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { TicketResponse } from "@clipsync/protocol";
import { requireDevice, type AuthVars } from "../auth";
import { newToken, sha256 } from "../ids";

const TICKET_TTL_MS = 30_000;

export const syncRoutes = new Hono<{ Bindings: Env; Variables: AuthVars }>()

  .post("/ticket", requireDevice, async (c) => {
    const ticket = newToken();
    const expiresAt = Date.now() + TICKET_TTL_MS;

    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM sync_tickets WHERE expires_at < ?").bind(
        Date.now(),
      ),
      c.env.DB.prepare(
        `INSERT INTO sync_tickets (ticket_hash, user_id, device_id, expires_at)
         VALUES (?, ?, ?, ?)`,
      ).bind(
        await sha256(ticket),
        c.var.device.userId,
        c.var.device.deviceId,
        expiresAt,
      ),
    ]);

    return c.json<TicketResponse>({ ticket, expiresAt });
  })

  .get("/ws", async (c) => {
    if (c.req.header("upgrade") !== "websocket") {
      throw new HTTPException(426, { message: "expected websocket upgrade" });
    }

    const ticket = c.req.query("ticket");
    if (!ticket) throw new HTTPException(401, { message: "ticket required" });

    // Single-use: the DELETE is the claim, so a replayed ticket finds nothing.
    const claimed = await c.env.DB.prepare(
      `DELETE FROM sync_tickets
        WHERE ticket_hash = ? AND expires_at > ?
        RETURNING user_id, device_id`,
    )
      .bind(await sha256(ticket), Date.now())
      .first<{ user_id: string; device_id: string }>();

    if (!claimed) {
      throw new HTTPException(401, { message: "ticket invalid or expired" });
    }

    const device = await c.env.DB.prepare(
      "SELECT name FROM devices WHERE id = ? AND revoked_at IS NULL",
    )
      .bind(claimed.device_id)
      .first<{ name: string }>();

    if (!device) {
      throw new HTTPException(401, { message: "device revoked" });
    }

    c.executionCtx.waitUntil(
      c.env.DB.prepare("UPDATE devices SET last_seen = ? WHERE id = ?")
        .bind(Date.now(), claimed.device_id)
        .run(),
    );

    // Identity is settled here; the Durable Object trusts these headers
    // because only this handler can reach it.
    return c.env.SYNC.getByName(claimed.user_id).fetch(
      new Request(c.req.url, {
        headers: {
          upgrade: "websocket",
          "x-clipsync-device-id": claimed.device_id,
          "x-clipsync-device-name": device.name,
        },
      }),
    );
  });
