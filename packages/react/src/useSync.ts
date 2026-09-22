/**
 * Live sync socket for the browser.
 *
 * Tickets are single-use, so every reconnect mints a fresh one. Presence is
 * derived from the `ready` frame plus subsequent connect/disconnect events
 * rather than polled.
 */

import { useEffect, useRef, useState } from "react";
import { PING_FRAME, type ServerMessage, type SyncEvent } from "@clipsync/protocol";
import type { ApiClient } from "@clipsync/client";

const PING_INTERVAL_MS = 30_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export type SyncStatus = "connecting" | "online" | "offline";

export function useSync(
  api: ApiClient | null,
  onEvent: (event: SyncEvent) => void,
): { status: SyncStatus; connected: string[] } {
  const [status, setStatus] = useState<SyncStatus>("connecting");
  const [connected, setConnected] = useState<string[]>([]);

  // Kept in a ref so reconnects never re-subscribe with a stale closure.
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    if (!api) return;

    let socket: WebSocket | null = null;
    let pingTimer: number | undefined;
    let reconnectTimer: number | undefined;
    let delay = RECONNECT_MIN_MS;
    let cancelled = false;

    const connect = async () => {
      if (cancelled) return;
      setStatus("connecting");

      try {
        const ws = new WebSocket(await api.syncUrl());
        socket = ws;

        ws.onopen = () => {
          delay = RECONNECT_MIN_MS;
          setStatus("online");
          pingTimer = window.setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) ws.send(PING_FRAME);
          }, PING_INTERVAL_MS);
        };

        ws.onmessage = (event) => {
          let msg: ServerMessage;
          try {
            msg = JSON.parse(event.data as string) as ServerMessage;
          } catch {
            return;
          }

          if (msg.type === "pong") return;
          if (msg.type === "ready") {
            setConnected(msg.connected);
            return;
          }
          if (msg.type === "device.connected") {
            setConnected((prev) =>
              prev.includes(msg.deviceId) ? prev : [...prev, msg.deviceId],
            );
          }
          if (msg.type === "device.disconnected") {
            setConnected((prev) => prev.filter((id) => id !== msg.deviceId));
          }
          handler.current(msg);
        };

        ws.onclose = () => {
          window.clearInterval(pingTimer);
          setStatus("offline");
          scheduleReconnect();
        };
      } catch {
        setStatus("offline");
        scheduleReconnect();
      }
    };

    const scheduleReconnect = () => {
      if (cancelled) return;
      reconnectTimer = window.setTimeout(connect, delay);
      delay = Math.min(delay * 2, RECONNECT_MAX_MS);
    };

    void connect();

    return () => {
      cancelled = true;
      window.clearInterval(pingTimer);
      window.clearTimeout(reconnectTimer);
      socket?.close(1000, "unmount");
    };
  }, [api]);

  return { status, connected };
}
