/**
 * End-to-end smoke test against a running Worker.
 *
 *   Terminal 1: npm run dev
 *   Terminal 2: npm run e2e
 *
 * Exercises the real HTTP + WebSocket surface with real encryption, standing
 * in for two devices. Complements the unit tests in packages/crypto: those
 * prove the envelope format, this proves the wiring.
 *
 * Writes to the local D1 database, so run it against `wrangler dev --local`.
 */

import { ApiClient, ApiRequestError } from "@clipsync/client";
import { changePassphrase, unlockVault } from "@clipsync/client/vault";
import { claimInvite, createInvite, parseInviteUrl } from "@clipsync/client/invite";
import { inviteProof } from "@clipsync/crypto";
import {
  approveLink,
  awaitApproval,
  beginLink,
  parseLinkUrl,
} from "@clipsync/client/link";
import { createLinkKeypair } from "@clipsync/crypto";
import { encryptText, decryptText, dedupeHash, vaultKeysFrom } from "@clipsync/crypto";
import { PING_FRAME, MAX_ENVELOPE_BYTES, type ServerMessage } from "@clipsync/protocol";

const BASE = process.env.CLIPSYNC_URL ?? "http://127.0.0.1:8787";
const ADMIN = process.env.CLIPSYNC_ADMIN_SECRET ?? "local-dev-admin-secret";
const PASS = "correct horse battery staple";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${detail}`); }
}

async function expectStatus(name: string, fn: () => Promise<unknown>, status: number) {
  try { await fn(); check(name, false, "(no error thrown)"); }
  catch (e) {
    const got = e instanceof ApiRequestError ? e.status : -1;
    check(name, got === status, `expected ${status} got ${got}`);
  }
}

console.log("\n--- auth ---");
await expectStatus("wrong admin secret is rejected",
  () => new ApiClient(BASE).bootstrap("wrong-secret", "pc", "linux"), 403);

const pc = await new ApiClient(BASE).bootstrap(ADMIN, "test-pc", "linux");
check("bootstrap returns credentials", Boolean(pc.token && pc.userId && pc.kdfSalt));

const pcApi = new ApiClient(BASE, pc.token);
const me = await pcApi.me();
check("whoami matches enrolled device", me.deviceId === pc.deviceId && me.deviceName === "test-pc");
await expectStatus("bad token is rejected", () => new ApiClient(BASE, "garbage").me(), 401);

console.log("\n--- vault ---");
const unlocked = await unlockVault(
  pcApi, PASS, pc.kdfSalt, pc.wrappedVaultKey, pc.createdAccount ?? false,
);
const vaultKey = unlocked.vaultKey;
check("vault key is available after bootstrap", Boolean(vaultKey));

const storedVault = await pcApi.vaultKey();
check("server stores only the wrapped vault key",
  Boolean(storedVault.wrappedVaultKey?.startsWith("k1.")) &&
  !storedVault.wrappedVaultKey!.includes(vaultKey),
  "raw vault key leaked to the server!");

const reopened = await unlockVault(pcApi, PASS, pc.kdfSalt, storedVault.wrappedVaultKey);
check("the same passphrase reopens the same vault key", reopened.vaultKey === vaultKey);

let wrongRejected = false;
try {
  await unlockVault(pcApi, "definitely the wrong one", pc.kdfSalt, storedVault.wrappedVaultKey);
} catch { wrongRejected = true; }
check("a wrong passphrase cannot unwrap the vault key", wrongRejected);

console.log("\n--- clips ---");
const keys = await vaultKeysFrom(vaultKey, pc.kdfSalt);
const TEXT = "docker compose up -d";
const created = await pcApi.createClip({
  type: "text", envelope: await encryptText(keys, TEXT),
  contentHash: await dedupeHash(keys, TEXT), size: Buffer.byteLength(TEXT),
});
check("clip created", !created.deduped && created.id.startsWith("clip_"));

const listed = await pcApi.listClips(10);
check("clip appears in history", listed.clips[0]?.id === created.id);
check("stored payload is ciphertext",
  !JSON.stringify(listed.clips[0]).includes(TEXT),
  "plaintext leaked into the API response!");
check("clip decrypts to the original",
  (await decryptText(keys, listed.clips[0]!.envelope)) === TEXT);

const again = await pcApi.createClip({
  type: "text", envelope: await encryptText(keys, TEXT),
  contentHash: await dedupeHash(keys, TEXT), size: Buffer.byteLength(TEXT),
});
check("repeat of newest clip is deduped", again.deduped && again.id === created.id);

const other = "git reset --soft HEAD~1";
const otherClip = await pcApi.createClip({
  type: "text", envelope: await encryptText(keys, other),
  contentHash: await dedupeHash(keys, other), size: Buffer.byteLength(other),
});
check("different content is not deduped", !otherClip.deduped);

await expectStatus("oversized envelope is refused", () => pcApi.createClip({
  type: "text", envelope: "v1.aaaa." + "A".repeat(MAX_ENVELOPE_BYTES),
  contentHash: "x", size: 1,
}), 413);

console.log("\n--- pairing ---");
const { code } = await pcApi.pairCode();
check("pair code has the documented shape", /^PAIR-[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(code));

const laptop = await new ApiClient(BASE).pair(code, "test-laptop", "linux");
check("pairing yields a token", Boolean(laptop.token));
check("paired device shares the vault salt", laptop.kdfSalt === pc.kdfSalt);
await expectStatus("pair code is single use",
  () => new ApiClient(BASE).pair(code, "impostor", "linux"), 400);
await expectStatus("unknown pair code is rejected",
  () => new ApiClient(BASE).pair("PAIR-ZZZZ-ZZZZ", "impostor", "linux"), 400);

const laptopApi = new ApiClient(BASE, laptop.token);
// The paired device unwraps the vault key rather than deriving content keys
// from the passphrase. On an account with a random vault key those are not
// the same thing, which is the whole point of the indirection.
const laptopVault = await unlockVault(
  laptopApi, PASS, laptop.kdfSalt, laptop.wrappedVaultKey,
);
check("paired device unwraps the same vault key", laptopVault.vaultKey === vaultKey);
const laptopKeys = await vaultKeysFrom(laptopVault.vaultKey, laptop.kdfSalt);
const fromLaptop = await laptopApi.listClips(10);
check("paired device decrypts existing history",
  (await decryptText(laptopKeys, fromLaptop.clips.at(-1)!.envelope)) === TEXT);

/** Polls until `predicate` holds, rather than sleeping a fixed interval. */
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return predicate();
}

console.log("\n--- realtime sync ---");
const socket = new WebSocket(await laptopApi.syncUrl());
const received: ServerMessage[] = [];
socket.addEventListener("message", (e) => received.push(JSON.parse(e.data as string)));
await new Promise<void>((res, rej) => {
  socket.addEventListener("open", () => res());
  socket.addEventListener("error", () => rej(new Error("ws failed")));
  setTimeout(() => rej(new Error("ws open timeout")), 5000);
});
await new Promise((r) => setTimeout(r, 300));
check("server sends a ready frame", received[0]?.type === "ready");

const SYNCED = "npm install hono";
await pcApi.createClip({
  type: "text", envelope: await encryptText(keys, SYNCED),
  contentHash: await dedupeHash(keys, SYNCED), size: Buffer.byteLength(SYNCED),
});
await waitFor(() => received.some((m) => m.type === "clip.created"));

const pushed = received.find((m) => m.type === "clip.created");
check("laptop receives the clip pushed by the pc", Boolean(pushed));
if (pushed && pushed.type === "clip.created") {
  check("pushed clip decrypts on the laptop",
    (await decryptText(laptopKeys, pushed.clip.envelope)) === SYNCED);
  check("event names the originating device", pushed.origin === pc.deviceId);
}

socket.send(PING_FRAME);
// Waited for rather than slept on: the first round trip to a cold Durable
// Object can take a few hundred milliseconds over a real network.
check("keepalive is answered",
  await waitFor(() => received.some((m) => m.type === "pong")));

const devices = await pcApi.devices();
const ids = new Set(devices.devices.map((d) => d.id));
// Asserted by membership, not by count: the local D1 database persists
// between runs of this script.
check("both devices are listed", ids.has(pc.deviceId) && ids.has(laptop.deviceId));
check("laptop shows as online",
  devices.devices.find((d) => d.id === laptop.deviceId)?.online === true);

console.log("\n--- device linking (QR handshake) ---");

// The joining device never learns the passphrase by being told it.
const pending = await beginLink(BASE, "linked-laptop", "linux");
check("link url carries the public key out of band",
  parseLinkUrl(pending.url)?.publicKey === pending.keypair.publicKey);
check("fingerprint is human-checkable", /^\d{3}-\d{3}$/.test(pending.fingerprint));

const parsed = parseLinkUrl(pending.url)!;

// An approver handed a *different* key than the one it scanned must refuse.
const impostor = await createLinkKeypair();
let refused = false;
try {
  await approveLink(BASE, pc.token, parsed.linkId, impostor.publicKey, vaultKey);
} catch {
  refused = true;
}
check("approver refuses a key that does not match the scanned one", refused);

const approvalDone = approveLink(BASE, pc.token, parsed.linkId, parsed.publicKey, vaultKey);
const [, linked] = await Promise.all([approvalDone, awaitApproval(BASE, pending)]);

check("linked device receives working credentials", Boolean(linked.credentials.token));
check("linked device recovers the vault key without typing a passphrase",
  Boolean(linked.vaultKey) && linked.vaultKey.length > 20);
check("linked device shares the vault salt", linked.credentials.kdfSalt === pc.kdfSalt);

const linkedApi = new ApiClient(BASE, linked.credentials.token);
const linkedKeys = await vaultKeysFrom(linked.vaultKey, linked.credentials.kdfSalt);
const linkedHistory = await linkedApi.listClips(10);
check("linked device decrypts existing history",
  (await decryptText(linkedKeys, linkedHistory.clips.at(-1)!.envelope)) === TEXT);

// The claim deletes the row, so a replay finds nothing.
const replayClaim = await fetch(new URL(`/api/link/${parsed.linkId}/claim`, BASE), {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ pickupToken: pending.pickupToken }),
});
check("pickup token is single use", replayClaim.status === 404,
  `got ${replayClaim.status}`);

const strangerClaim = await fetch(new URL(`/api/link/${parsed.linkId}/claim`, BASE), {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ pickupToken: "not-the-right-token" }),
});
check("a wrong pickup token is refused", strangerClaim.status === 404,
  `got ${strangerClaim.status}`);

console.log("\n--- scan-to-join invites ---");

const invite = await createInvite(pcApi, BASE, vaultKey);
check("invite url carries the secret in the fragment",
  parseInviteUrl(invite.url)?.secret === invite.secret);

// Knowing the id without having scanned the QR must not be enough.
let idAloneRefused = false;
try {
  await claimInvite(new ApiClient(BASE), invite.inviteId,
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "impostor", "other");
} catch { idAloneRefused = true; }
check("the invite id alone cannot claim a device", idAloneRefused);

const phone = await claimInvite(
  new ApiClient(BASE), invite.inviteId, invite.secret, "test-phone", "other",
);
check("scanning device gets the vault key", phone.vaultKey === vaultKey);
check("scanning device gets working credentials", Boolean(phone.credentials.token));

const phoneApi = new ApiClient(BASE, phone.credentials.token);
const phoneKeys = await vaultKeysFrom(phone.vaultKey, phone.credentials.kdfSalt);
const phoneHistory = await phoneApi.listClips(10);
check("scanning device decrypts existing history",
  (await decryptText(phoneKeys, phoneHistory.clips.at(-1)!.envelope)) === TEXT);

let replayRefused = false;
try {
  await claimInvite(new ApiClient(BASE), invite.inviteId, invite.secret, "second-phone", "other");
} catch { replayRefused = true; }
check("an invite works exactly once", replayRefused);

// The server holds the sealed payload and the proof; neither may open it.
check("proof is not the sealing secret",
  (await inviteProof(invite.secret)) !== invite.secret);

console.log("\n--- passphrase rotation ---");

await changePassphrase(pcApi, vaultKey, pc.kdfSalt, "a brand new passphrase");
const afterRotation = await pcApi.vaultKey();

const withNew = await unlockVault(pcApi, "a brand new passphrase", pc.kdfSalt, afterRotation.wrappedVaultKey);
check("the new passphrase opens the same vault key", withNew.vaultKey === vaultKey);

let oldRejected = false;
try {
  await unlockVault(pcApi, PASS, pc.kdfSalt, afterRotation.wrappedVaultKey);
} catch { oldRejected = true; }
check("the old passphrase no longer unwraps it", oldRejected);

const stillReadable = await pcApi.listClips(10);
check("clips written before the change still decrypt",
  (await decryptText(await vaultKeysFrom(withNew.vaultKey, pc.kdfSalt),
    stillReadable.clips.at(-1)!.envelope)) === TEXT,
  "rotation should re-wrap 32 bytes, not re-encrypt history");

console.log("\n--- tickets & revocation ---");
/** Resolves true if the socket opens, false if the server refuses it. */
function opens(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const done = (ok: boolean) => { try { ws.close(); } catch {} resolve(ok); };
    ws.addEventListener("open", () => done(true));
    ws.addEventListener("error", () => done(false));
    setTimeout(() => done(false), 4000);
  });
}

const t = await laptopApi.syncTicket();
const ticketUrl = new URL("/api/sync/ws", BASE);
ticketUrl.protocol = ticketUrl.protocol === "https:" ? "wss:" : "ws:";
ticketUrl.searchParams.set("ticket", t.ticket);

check("valid ticket upgrades", await opens(ticketUrl.toString()));
check("replayed ticket is refused", !(await opens(ticketUrl.toString())));
check("forged ticket is refused",
  !(await opens(ticketUrl.toString().replace(/ticket=.*$/, "ticket=made-up"))));

await expectStatus("a device cannot revoke itself",
  () => pcApi.revokeDevice(pc.deviceId), 400);
await pcApi.revokeDevice(laptop.deviceId);
await expectStatus("revoked token stops working", () => laptopApi.me(), 401);

socket.close();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
