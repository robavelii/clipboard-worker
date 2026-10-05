/**
 * SMTP over TLS on Node, for the Worker's mail client (apps/worker/src/mail.ts),
 * which speaks the protocol over any pair of byte streams.
 */

import { connect } from "node:tls";
import { Duplex } from "node:stream";
import type { MailSocket } from "clipsync:worker-app";

export function tlsConnect(host: string, port: number): Promise<MailSocket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port, servername: host }, () => {
      const { readable, writable } = Duplex.toWeb(socket) as {
        readable: ReadableStream<Uint8Array>;
        writable: WritableStream<Uint8Array>;
      };
      resolve({ readable, writable, close: () => socket.end() });
    });
    socket.once("error", reject);
  });
}
