/**
 * Sending email: signup codes (decisions §45).
 *
 * One SMTP client, over whatever socket the runtime has: the Worker entry
 * passes Cloudflare's TCP sockets, apps/server passes Node's TLS. Both are
 * a byte stream each way, so the conversation here is the same on both, and
 * nothing in this file imports a runtime. It speaks SMTP over TLS from the
 * first byte (port 465, as OCI Email Delivery takes it) with AUTH PLAIN, and
 * sends one plain-text message per connection: a code now and then needs no
 * pooling.
 *
 * The body goes as base64, so no line of it can start with a dot or run
 * past SMTP's line limit, and no header is built from anything a client sent
 * except the address, which is validated (`normaliseEmail`) before it gets
 * here.
 */

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/** A byte stream each way: cloudflare:sockets' Socket has this shape, and so does a web-streams TLS socket on Node. */
export interface MailSocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close(): unknown;
}

export type Connect = (host: string, port: number) => MailSocket | Promise<MailSocket>;

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  /** The sender, e.g. `noreply@clip.example.org`; it must be approved by the provider. */
  from: string;
}

/** Messages kept, not sent, when MAIL_MODE is `outbox`: the Worker tests read them. */
export const outbox: MailMessage[] = [];

/**
 * The mailer this server's settings describe: the outbox in tests, SMTP when
 * a host, credentials and sender are set, or null when mail is not set up.
 */
export function mailerFor(
  env: { MAIL_MODE?: string; MAIL_FROM?: string; SMTP_HOST?: string; SMTP_PORT?: string | number; SMTP_USER?: string; SMTP_PASSWORD?: string },
  connect: Connect | null,
): Mailer | null {
  if (env.MAIL_MODE === "outbox") return { send: async (m) => void outbox.push(m) };
  if (!connect || !env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASSWORD || !env.MAIL_FROM) return null;
  return smtpMailer(
    {
      host: env.SMTP_HOST,
      port: Number(env.SMTP_PORT || 465),
      user: env.SMTP_USER,
      password: env.SMTP_PASSWORD,
      from: env.MAIL_FROM,
    },
    connect,
  );
}

export function smtpMailer(config: SmtpConfig, connect: Connect): Mailer {
  return { send: (message) => sendMail(config, connect, message) };
}

const encoder = new TextEncoder();

function base64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** RFC 2047, for a subject that is not plain ASCII. */
function encodeHeader(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${base64(encoder.encode(value))}?=`;
}

export function formatMessage(config: Pick<SmtpConfig, "from">, message: MailMessage, now = new Date()): string {
  const domain = config.from.split("@")[1] ?? "localhost";
  const body = base64(encoder.encode(message.text)).replace(/.{1,76}/g, "$&\r\n");
  return [
    `From: ClipSync <${config.from}>`,
    `To: <${message.to}>`,
    `Subject: ${encodeHeader(message.subject)}`,
    `Date: ${now.toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    body,
  ].join("\r\n");
}

/** Reads CRLF-terminated lines off a byte stream. */
function lineReader(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  return {
    async next(): Promise<string> {
      for (;;) {
        const end = buffered.indexOf("\r\n");
        if (end >= 0) {
          const line = buffered.slice(0, end);
          buffered = buffered.slice(end + 2);
          return line;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error("SMTP: the server closed the connection");
        buffered += decoder.decode(value, { stream: true });
      }
    },
    release: () => reader.releaseLock(),
  };
}

async function sendMail(config: SmtpConfig, connect: Connect, message: MailMessage): Promise<void> {
  if (/[\r\n<>]/.test(message.to)) throw new Error("SMTP: refusing an address with control characters");
  const socket = await connect(config.host, config.port);
  const lines = lineReader(socket.readable);
  const writer = socket.writable.getWriter();
  const write = (text: string) => writer.write(encoder.encode(text));

  // A reply is one or more lines; all but the last carry a dash after the code.
  const reply = async (...expected: number[]): Promise<void> => {
    let line: string;
    do line = await lines.next();
    while (/^\d{3}-/.test(line));
    const code = Number(line.slice(0, 3));
    if (!expected.includes(code)) throw new Error(`SMTP: expected ${expected.join(" or ")}, got "${line}"`);
  };
  const command = async (text: string, ...expected: number[]) => {
    await write(`${text}\r\n`);
    await reply(...expected);
  };

  try {
    await reply(220);
    await command(`EHLO ${config.from.split("@")[1] ?? "localhost"}`, 250);
    await command(`AUTH PLAIN ${base64(encoder.encode(`\0${config.user}\0${config.password}`))}`, 235);
    await command(`MAIL FROM:<${config.from}>`, 250);
    await command(`RCPT TO:<${message.to}>`, 250, 251);
    await command("DATA", 354);
    await write(`${formatMessage(config, message)}\r\n.\r\n`);
    await reply(250);
    // The message is accepted; a server that drops the line before its
    // goodbye has still taken it.
    await command("QUIT", 221).catch(() => undefined);
  } finally {
    lines.release();
    writer.releaseLock();
    try {
      await socket.close();
    } catch {
      // Already closed by the server's goodbye.
    }
  }
}
