/**
 * Cloudflare Email Service as the mailer (decisions §51): chosen over SMTP
 * when the Worker has the binding and a sender, never over the test outbox.
 */

import { describe, expect, it } from "vitest";
import { mailerFor, type EmailBinding } from "../src/mail";

function fakeBinding() {
  const sent: Parameters<EmailBinding["send"]>[0][] = [];
  return { sent, binding: { send: async (m: Parameters<EmailBinding["send"]>[0]) => void sent.push(m) } as EmailBinding };
}

describe("choosing the mailer", () => {
  it("sends through the binding, as ClipSync, when there is one and a sender", async () => {
    const { sent, binding } = fakeBinding();
    const mailer = mailerFor({ MAIL_FROM: "noreply@clip.example.org", SMTP_HOST: "smtp.example.org", SMTP_USER: "u", SMTP_PASSWORD: "p" }, null, binding);
    await mailer!.send({ to: "owner@example.org", subject: "Your code", text: "123456" });
    expect(sent).toEqual([
      { to: "owner@example.org", from: { email: "noreply@clip.example.org", name: "ClipSync" }, subject: "Your code", text: "123456" },
    ]);
  });

  it("has no mailer with a binding but no sender, or with neither set up", () => {
    expect(mailerFor({ MAIL_FROM: "" }, null, fakeBinding().binding)).toBeNull();
    expect(mailerFor({ MAIL_FROM: "noreply@clip.example.org" }, null, null)).toBeNull();
  });

  it("keeps the outbox first, so tests never send", async () => {
    const { sent, binding } = fakeBinding();
    const mailer = mailerFor({ MAIL_MODE: "outbox", MAIL_FROM: "noreply@clip.example.org" }, null, binding);
    await mailer!.send({ to: "owner@example.org", subject: "s", text: "t" });
    expect(sent).toHaveLength(0);
  });
});
