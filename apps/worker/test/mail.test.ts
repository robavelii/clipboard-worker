/**
 * The SMTP client (mail.ts) against a scripted server: the conversation it
 * holds, the message it sends, and that it gives up on a refusal.
 */

import { describe, expect, it } from "vitest";
import { smtpMailer, type MailSocket } from "../src/mail";

// A login made up per run: the client must send exactly what it was given.
const config = { host: "smtp.test", port: 465, user: "ocid.user", password: crypto.randomUUID(), from: "noreply@clip.test" };

/** A server that answers each command by `answer`, recording what it was sent. */
function scriptedServer(answer: (command: string) => string) {
  const sent: string[] = [];
  const toClient = new TransformStream<Uint8Array, Uint8Array>();
  const toServer = new TransformStream<Uint8Array, Uint8Array>();
  const say = toClient.writable.getWriter();
  const enc = new TextEncoder();
  void (async () => {
    await say.write(enc.encode("220 smtp.test ESMTP ready\r\n"));
    const reader = toServer.readable.getReader();
    const dec = new TextDecoder();
    let buffer = "";
    let inData = false;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += dec.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        sent.push(line);
        if (inData) {
          if (line === ".") {
            inData = false;
            await say.write(enc.encode("250 queued\r\n"));
          }
          continue;
        }
        const reply = answer(line);
        if (line === "DATA" && reply.startsWith("354")) inData = true;
        await say.write(enc.encode(`${reply}\r\n`));
      }
    }
  })();
  const socket: MailSocket = { readable: toClient.readable, writable: toServer.writable, close: () => void say.close().catch(() => undefined) };
  return { socket, sent };
}

const happy = (command: string): string => {
  if (command.startsWith("EHLO")) return "250-smtp.test\r\n250 AUTH PLAIN";
  if (command.startsWith("AUTH PLAIN")) return "235 authenticated";
  if (command === "DATA") return "354 go ahead";
  if (command === "QUIT") return "221 bye";
  return "250 ok";
};

describe("smtp", () => {
  it("authenticates, addresses and sends one base64 message", async () => {
    const server = scriptedServer(happy);
    await smtpMailer(config, () => server.socket).send({ to: "ada@example.org", subject: "Your code: 123456", text: "Code 123456.\nThanks ✓" });

    expect(server.sent[0]).toBe("EHLO clip.test");
    expect(server.sent[1]).toBe(`AUTH PLAIN ${btoa(`\0ocid.user\0${config.password}`)}`);
    expect(server.sent).toContain("MAIL FROM:<noreply@clip.test>");
    expect(server.sent).toContain("RCPT TO:<ada@example.org>");
    const data = server.sent.slice(server.sent.indexOf("DATA") + 1, server.sent.indexOf("."));
    expect(data).toContain("Subject: Your code: 123456");
    expect(data).toContain("Content-Transfer-Encoding: base64");
    const body = data.slice(data.indexOf("") + 1).join("");
    expect(new TextDecoder().decode(Uint8Array.from(atob(body), (c) => c.charCodeAt(0)))).toBe("Code 123456.\nThanks ✓");
  });

  it("stops at a refusal and says what the server answered", async () => {
    const server = scriptedServer((c) => (c.startsWith("AUTH") ? "535 authentication failed" : happy(c)));
    await expect(smtpMailer(config, () => server.socket).send({ to: "ada@example.org", subject: "x", text: "y" })).rejects.toThrow(
      /535 authentication failed/,
    );
    expect(server.sent.some((l) => l.startsWith("MAIL FROM"))).toBe(false);
  });

  it("refuses an address that could add a header", async () => {
    const server = scriptedServer(happy);
    await expect(
      smtpMailer(config, () => server.socket).send({ to: "a@example.org>\r\nBcc: <b@example.org", subject: "x", text: "y" }),
    ).rejects.toThrow(/control characters/);
  });
});
