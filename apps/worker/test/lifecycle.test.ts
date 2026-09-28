import { createExecutionContext, createScheduledController, SELF, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Clip, ListClipsResponse, SyncEvent, TicketResponse } from "@clipsync/protocol";
import worker from "../src/index";
import { api, bootstrap, v2Envelope } from "./helpers";

const PUBLIC_KEY = `B${"Q".repeat(86)}`;

/** Store clips straight into D1, so tests control created_at. */
async function insertClips(
  userId: string,
  deviceId: string,
  rows: { id: string; createdAt: number; expiresAt?: number | null; pinned?: boolean }[],
): Promise<void> {
  await env.DB.batch(
    rows.map((r) =>
      env.DB.prepare(
        `INSERT INTO clips
           (id, user_id, device_id, type, envelope, content_hash, size, pinned, created_at, expires_at, key_epoch)
         VALUES (?, ?, ?, 'text', 'v1.aXY.Y3Q', ?, 1, ?, ?, ?, 0)`,
      ).bind(r.id, userId, deviceId, `hash-${r.id}`, r.pinned ? 1 : 0, r.createdAt, r.expiresAt ?? null),
    ),
  );
}

async function runCron(): Promise<void> {
  const ctx = createExecutionContext();
  await worker.scheduled(createScheduledController(), env, ctx);
  await waitOnExecutionContext(ctx);
}

describe("history paging", () => {
  it("does not skip clips that share a millisecond", async () => {
    const owner = await bootstrap("owner");
    const t = 1_700_000_000_000;
    await insertClips(owner.userId, owner.deviceId, [
      { id: "clip_a", createdAt: t },
      { id: "clip_b", createdAt: t },
      { id: "clip_c", createdAt: t },
      { id: "clip_d", createdAt: t - 1 },
      { id: "clip_e", createdAt: t - 1 },
    ]);

    const seen: string[] = [];
    let before: string | number | null = null;
    do {
      const qs: string = before === null ? "" : `&before=${before}`;
      const page = (await (
        await api(`/api/clips?limit=2${qs}`, { token: owner.token })
      ).json()) as ListClipsResponse;
      seen.push(...page.clips.map((c) => c.id));
      before = page.nextCursor;
    } while (before !== null);

    expect(seen).toEqual(["clip_c", "clip_b", "clip_a", "clip_e", "clip_d"]);
  });

  it("still pages from a bare timestamp, as older clients send", async () => {
    const owner = await bootstrap("owner");
    const t = 1_700_000_000_000;
    await insertClips(owner.userId, owner.deviceId, [
      { id: "clip_new", createdAt: t },
      { id: "clip_old", createdAt: t - 5 },
    ]);
    const page = (await (
      await api(`/api/clips?before=${t}`, { token: owner.token })
    ).json()) as ListClipsResponse;
    expect(page.clips.map((c: Clip) => c.id)).toEqual(["clip_old"]);
  });
});

describe("DELETE /api/devices/me", () => {
  it("revokes the calling device and only it", async () => {
    const owner = await bootstrap("owner");
    const laptop = await bootstrap("laptop");

    expect((await api("/api/devices/me", { method: "DELETE", token: laptop.token })).status).toBe(200);
    expect((await api("/api/auth/me", { token: laptop.token })).status).toBe(401);
    expect((await api("/api/auth/me", { token: owner.token })).status).toBe(200);

    const { devices } = (await (
      await api("/api/devices", { token: owner.token })
    ).json()) as { devices: { id: string }[] };
    expect(devices.map((d) => d.id)).not.toContain(laptop.deviceId);
  });

  it("still refuses revoking yourself by id", async () => {
    const owner = await bootstrap("owner");
    const res = await api(`/api/devices/${owner.deviceId}`, { method: "DELETE", token: owner.token });
    expect(res.status).toBe(400);
  });
});

/** A link request approved by `approver` and never collected. */
async function approvedLink(approverToken: string) {
  const request = (await (
    await api("/api/link/request", {
      method: "POST",
      body: { publicKey: PUBLIC_KEY, deviceName: "joiner", platform: "linux" },
    })
  ).json()) as { linkId: string; pickupToken: string };
  const approved = await api(`/api/link/${request.linkId}/approve`, {
    method: "POST",
    token: approverToken,
    body: { approverPublicKey: PUBLIC_KEY, wrappedSecret: "l1.aXY.Y3Q" },
  });
  expect(approved.status).toBe(200);
  const { deviceId } = (await approved.json()) as { deviceId: string };
  return { ...request, deviceId };
}

describe("link approvals", () => {
  it("hands the token to exactly one claim", async () => {
    const owner = await bootstrap("owner");
    const link = await approvedLink(owner.token);
    const claim = () =>
      api(`/api/link/${link.linkId}/claim`, { method: "POST", body: { pickupToken: link.pickupToken } });
    const statuses = (await Promise.all([claim(), claim(), claim()])).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 404, 404]);
  });

  it("still answers pending before approval", async () => {
    const request = (await (
      await api("/api/link/request", {
        method: "POST",
        body: { publicKey: PUBLIC_KEY, deviceName: "joiner", platform: "linux" },
      })
    ).json()) as { linkId: string; pickupToken: string };
    const res = await api(`/api/link/${request.linkId}/claim`, {
      method: "POST",
      body: { pickupToken: request.pickupToken },
    });
    expect(res.status).toBe(202);
  });

  it("revokes the device an uncollected approval enrolled, once it expires", async () => {
    const owner = await bootstrap("owner");
    const link = await approvedLink(owner.token);
    await env.DB.prepare("UPDATE link_requests SET expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1, link.linkId)
      .run();

    await runCron();

    const row = await env.DB.prepare("SELECT revoked_at FROM devices WHERE id = ?")
      .bind(link.deviceId)
      .first<{ revoked_at: number | null }>();
    expect(row?.revoked_at).not.toBeNull();
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM link_requests").first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});

describe("the expiry cron", () => {
  it("deletes expired unpinned clips and tells connected devices", async () => {
    const owner = await bootstrap("owner");
    const phone = await bootstrap("phone");
    const now = Date.now();
    await insertClips(owner.userId, owner.deviceId, [
      { id: "clip_expired", createdAt: now - 10, expiresAt: now - 1 },
      { id: "clip_pinned", createdAt: now - 10, expiresAt: now - 1, pinned: true },
      { id: "clip_live", createdAt: now - 10, expiresAt: now + 60_000 },
    ]);

    const { ticket } = (await (
      await api("/api/sync/ticket", { method: "POST", token: phone.token })
    ).json()) as TicketResponse;
    const upgrade = await SELF.fetch(`https://clip.test/api/sync/ws?ticket=${ticket}`, {
      headers: { upgrade: "websocket" },
    });
    const ws = upgrade.webSocket!;
    const received: SyncEvent[] = [];
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(String(e.data)) as SyncEvent | { type: string };
      if (msg.type === "clip.deleted") received.push(msg as SyncEvent);
    });
    ws.accept();

    await runCron();
    for (let i = 0; i < 50 && !received.length; i++) await new Promise((r) => setTimeout(r, 20));
    ws.close();

    const { results } = await env.DB.prepare("SELECT id FROM clips ORDER BY id").all<{ id: string }>();
    expect(results.map((r) => r.id)).toEqual(["clip_live", "clip_pinned"]);
    expect(received).toMatchObject([{ type: "clip.deleted", clipId: "clip_expired" }]);
  });
});

describe("v2 envelopes", () => {
  async function post(token: string, envelope: string, contentHash = `h-${Math.random()}`) {
    return api("/api/clips", {
      method: "POST",
      token,
      body: { type: "text", envelope, contentHash, size: 1, keyEpoch: 0 },
    });
  }

  it("are stored when they name the writing device", async () => {
    const owner = await bootstrap("owner");
    const envelope = v2Envelope(owner.deviceId);
    const res = await post(owner.token, envelope);
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    const clip = (await (await api(`/api/clips/${id}`, { token: owner.token })).json()) as Clip;
    expect(clip.envelope).toBe(envelope);
  });

  it("are refused when they name another device or type, or do not parse", async () => {
    const owner = await bootstrap("owner");
    const phone = await bootstrap("phone");
    expect((await post(owner.token, v2Envelope(phone.deviceId))).status).toBe(400);
    expect((await post(owner.token, v2Envelope(owner.deviceId, "image"))).status).toBe(400);
    expect((await post(owner.token, "v2.bm90LWpzb24.aXY.Y3Q")).status).toBe(400);
    expect((await post(owner.token, "v9.aXY.Y3Q")).status).toBe(400);
  });

  it("replace the stored envelope when a copy is bumped", async () => {
    const owner = await bootstrap("owner");
    const phone = await bootstrap("phone");
    const first = (await (await post(owner.token, v2Envelope(owner.deviceId, "text", "a"), "same")).json()) as { id: string };
    await post(owner.token, v2Envelope(owner.deviceId, "text", "other"), "other");
    const again = v2Envelope(phone.deviceId, "text", "b");
    const bumped = (await (await post(phone.token, again, "same")).json()) as { id: string; deduped: boolean };
    expect(bumped).toMatchObject({ id: first.id, deduped: true });
    const clip = (await (await api(`/api/clips/${first.id}`, { token: owner.token })).json()) as Clip;
    expect(clip).toMatchObject({ envelope: again, deviceId: phone.deviceId });
  });
});
