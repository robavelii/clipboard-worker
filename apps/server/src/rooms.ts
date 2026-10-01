/**
 * The SYNC binding (one SyncRoom per user), in process.
 *
 * Mirrors apps/worker/src/sync-room.ts method for method: the routes call
 * `getByName(userId)` and then `fetch` (the socket upgrade), `broadcast`,
 * `broadcastAll`, `connected` or `disconnect`, and get the same behaviour:
 * fan-out that skips the origin device, a `ready` frame with who is online,
 * `device.connected`/`device.disconnected` announcements, app-level ping
 * answered with pong, and revocation as a `revoked` frame then close 4001.
 *
 * The upgrade itself cannot happen inside `fetch`: on Node it belongs to the
 * HTTP server's `upgrade` event, outside any Request/Response. So `fetch`
 * checks the request the way the Durable Object does, parks the identity
 * under a random handle, and answers with that handle in a header. The
 * server (server.ts) reads the handle off the route's response and completes
 * the upgrade with `accept`. Handles come only from this module and live for
 * a few seconds, and the server strips the header from every other response.
 */

import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import { REVOKED_CLOSE_CODE, type SyncEvent } from "@clipsync/protocol";

export const UPGRADE_HANDLE_HEADER = "x-clipsync-upgrade";

const PONG = JSON.stringify({ type: "pong" });
const HANDLE_TTL_MS = 10_000;

interface Identity {
  room: Room;
  deviceId: string;
  deviceName: string;
}

interface Member {
  deviceId: string;
  deviceName: string;
}

export class Rooms {
  private readonly rooms = new Map<string, Room>();
  private readonly pending = new Map<string, Identity>();

  getByName(name: string): Room {
    let room = this.rooms.get(name);
    if (!room) {
      room = new Room(this);
      this.rooms.set(name, room);
    }
    return room;
  }

  /** @internal */
  park(identity: Identity): string {
    const handle = randomUUID();
    this.pending.set(handle, identity);
    setTimeout(() => this.pending.delete(handle), HANDLE_TTL_MS).unref();
    return handle;
  }

  /** Completes an upgrade the route approved. False if the handle is unknown or spent. */
  accept(handle: string, ws: WebSocket): boolean {
    const identity = this.pending.get(handle);
    if (!identity) return false;
    this.pending.delete(handle);
    identity.room.join(ws, identity.deviceId, identity.deviceName);
    return true;
  }

  /** Every open socket, for shutdown. */
  *sockets(): Iterable<WebSocket> {
    for (const room of this.rooms.values()) yield* room.sockets.keys();
  }
}

export class Room {
  /** @internal */
  readonly sockets = new Map<WebSocket, Member>();

  constructor(private readonly rooms: Rooms) {}

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade") !== "websocket") {
      return new Response("expected websocket upgrade", { status: 426 });
    }
    const deviceId = request.headers.get("x-clipsync-device-id");
    const deviceName = request.headers.get("x-clipsync-device-name");
    if (!deviceId || !deviceName) {
      return new Response("missing device identity", { status: 400 });
    }
    const handle = this.rooms.park({ room: this, deviceId, deviceName });
    return new Response(null, { status: 200, headers: { [UPGRADE_HANDLE_HEADER]: handle } });
  }

  async broadcast(event: SyncEvent): Promise<void> {
    this.fanout(event, event.origin);
  }

  async broadcastAll(events: SyncEvent[]): Promise<void> {
    for (const event of events) this.fanout(event, event.origin);
  }

  async connected(): Promise<string[]> {
    return this.connectedDeviceIds();
  }

  async disconnect(deviceId: string): Promise<number> {
    const frame = JSON.stringify({ type: "revoked" });
    let closed = 0;
    for (const [ws, member] of this.sockets) {
      if (member.deviceId !== deviceId) continue;
      try {
        ws.send(frame);
        ws.close(REVOKED_CLOSE_CODE, "device revoked");
      } catch {
        // Already closing.
      }
      closed++;
    }
    return closed;
  }

  /** @internal */
  join(ws: WebSocket, deviceId: string, deviceName: string): void {
    this.sockets.set(ws, { deviceId, deviceName });
    ws.on("message", (data, isBinary) => {
      // The only client frame is a keepalive.
      if (!isBinary && data.toString().includes("ping")) ws.send(PONG);
    });
    ws.on("close", () => this.leave(ws));
    ws.on("error", () => this.leave(ws));

    ws.send(JSON.stringify({ type: "ready", deviceId, connected: this.connectedDeviceIds(deviceId) }));
    this.fanout(
      {
        version: 1,
        eventId: randomUUID(),
        origin: deviceId,
        timestamp: Date.now(),
        type: "device.connected",
        deviceId,
        deviceName,
      },
      deviceId,
    );
  }

  private leave(ws: WebSocket): void {
    const member = this.sockets.get(ws);
    if (!member) return;
    this.sockets.delete(ws);
    // A reconnecting agent briefly holds two sockets: only announce once the
    // device has none left.
    for (const other of this.sockets.values()) {
      if (other.deviceId === member.deviceId) return;
    }
    this.fanout(
      {
        version: 1,
        eventId: randomUUID(),
        origin: member.deviceId,
        timestamp: Date.now(),
        type: "device.disconnected",
        deviceId: member.deviceId,
        deviceName: member.deviceName,
      },
      member.deviceId,
    );
  }

  private connectedDeviceIds(exclude?: string): string[] {
    const ids = new Set<string>();
    for (const member of this.sockets.values()) {
      if (member.deviceId !== exclude) ids.add(member.deviceId);
    }
    return [...ids];
  }

  private fanout(event: SyncEvent, exclude: string): void {
    const payload = JSON.stringify(event);
    for (const [ws, member] of this.sockets) {
      if (member.deviceId === exclude) continue;
      try {
        ws.send(payload);
      } catch {
        // Died between enumeration and send; its close handler cleans up.
      }
    }
  }
}
