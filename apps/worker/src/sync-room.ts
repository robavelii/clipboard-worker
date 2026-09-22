/**
 * One SyncRoom per user -- the fan-out point for that user's devices.
 *
 * Uses the WebSocket Hibernation API: the object can be evicted from memory
 * while sockets stay open, and keepalive pings are answered by the runtime
 * without waking it at all. All connection state therefore lives in each
 * socket's attachment, never in instance fields.
 */

import { DurableObject } from "cloudflare:workers";
import type { SyncEvent } from "@clipsync/protocol";

interface Attachment {
  deviceId: string;
  deviceName: string;
}

const PING = JSON.stringify({ type: "ping" });
const PONG = JSON.stringify({ type: "pong" });

export class SyncRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Answered by the runtime while hibernating -- no billed wakeup per ping.
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(PING, PONG),
    );
  }

  /**
   * WebSocket upgrade. Reached only after the Worker has validated a sync
   * ticket, which is where identity is established -- this method trusts the
   * headers because nothing else can route here.
   */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade") !== "websocket") {
      return new Response("expected websocket upgrade", { status: 426 });
    }

    const deviceId = request.headers.get("x-clipsync-device-id");
    const deviceName = request.headers.get("x-clipsync-device-name");
    if (!deviceId || !deviceName) {
      return new Response("missing device identity", { status: 400 });
    }

    const pair = new WebSocketPair();
    const server = pair[1]!;

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ deviceId, deviceName } satisfies Attachment);

    server.send(
      JSON.stringify({
        type: "ready",
        deviceId,
        connected: this.connectedDeviceIds(deviceId),
      }),
    );

    this.fanout(
      {
        version: 1,
        eventId: crypto.randomUUID(),
        origin: deviceId,
        timestamp: Date.now(),
        type: "device.connected",
        deviceId,
        deviceName,
      },
      deviceId,
    );

    return new Response(null, { status: 101, webSocket: pair[0]! });
  }

  /**
   * Push an event to every device except its origin. Called over RPC from the
   * Worker after the write to D1 has committed.
   */
  broadcast(event: SyncEvent): void {
    this.fanout(event, event.origin);
  }

  /** Device ids with a live socket right now. */
  connected(): string[] {
    return this.connectedDeviceIds();
  }

  override async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    // The only client frame is a keepalive, and the auto-response handles the
    // common case. This catches clients that ping with a different payload.
    if (typeof message === "string" && message.includes("ping")) {
      ws.send(PONG);
    }
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    this.announceDeparture(ws);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    this.announceDeparture(ws);
  }

  /* ----------------------------- internals ----------------------------- */

  private connectedDeviceIds(exclude?: string): string[] {
    const ids = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (att && att.deviceId !== exclude) ids.add(att.deviceId);
    }
    return [...ids];
  }

  private fanout(event: SyncEvent, exclude: string): void {
    const payload = JSON.stringify(event);
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (!att || att.deviceId === exclude) continue;
      try {
        ws.send(payload);
      } catch {
        // Socket died between enumeration and send; the close handler cleans up.
      }
    }
  }

  private announceDeparture(ws: WebSocket): void {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) return;

    // Only announce once the device has no sockets left -- a reconnecting
    // agent briefly holds two, and a spurious "offline" would flicker the UI.
    const stillHere = this.ctx
      .getWebSockets()
      .some((other) => {
        if (other === ws) return false;
        const a = other.deserializeAttachment() as Attachment | null;
        return a?.deviceId === att.deviceId;
      });
    if (stillHere) return;

    this.fanout(
      {
        version: 1,
        eventId: crypto.randomUUID(),
        origin: att.deviceId,
        timestamp: Date.now(),
        type: "device.disconnected",
        deviceId: att.deviceId,
        deviceName: att.deviceName,
      },
      att.deviceId,
    );
  }
}
