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
import { deleteAccountWithPassphrase } from "@clipsync/client/account";
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
import { authHashOf, openVault, wrapVaultKey } from "@clipsync/crypto";
import { generateDeviceKeypair, openVaultKeyForDevice } from "@clipsync/crypto";
import {
  reencryptHistory,
  refreshVaultRing,
  registerDeviceKey,
  rekeyVault,
} from "@clipsync/client/rekey";
import {
  currentKey,
  decryptClip,
  readClip,
  ringKeysFrom,
  ringOf,
  sealText,
  type VaultRing,
} from "@clipsync/client/ring";
import { downloadFile, uploadFile } from "@clipsync/client/files";
import {
  PING_FRAME,
  MAX_ENVELOPE_BYTES,
  REVOKED_CLOSE_CODE,
  STALE_EPOCH_ERROR,
  type ServerMessage,
} from "@clipsync/protocol";

const BASE = process.env.CLIPSYNC_URL ?? "http://127.0.0.1:8787";
const ADMIN = process.env.CLIPSYNC_ADMIN_SECRET ?? "local-dev-admin-secret";
const PASS = "correct horse battery staple";

/**
 * Payloads are tagged per run.
 *
 * Dedupe is global, so a fixture reused across runs is *bumped* rather than
 * created, and every "is this new?" assertion would fail the second time the
 * suite runs against the same database.
 */
const RUN = String(Date.now()).slice(-8);

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
/**
 * Each run re-keys the vault, so the epoch it starts at depends on how many
 * runs came before. Every write names it, as a real client's would.
 */
const EPOCH = pc.keyEpoch ?? 0;
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
const TEXT = `docker compose up -d # ${RUN}`;
const created = await pcApi.createClip({ keyEpoch: EPOCH,
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

const again = await pcApi.createClip({ keyEpoch: EPOCH,
  type: "text", envelope: await encryptText(keys, TEXT),
  contentHash: await dedupeHash(keys, TEXT), size: Buffer.byteLength(TEXT),
});
check("repeat of newest clip is deduped", again.deduped && again.id === created.id);

const other = `git reset --soft HEAD~1 # ${RUN}`;
const otherClip = await pcApi.createClip({ keyEpoch: EPOCH,
  type: "text", envelope: await encryptText(keys, other),
  contentHash: await dedupeHash(keys, other), size: Buffer.byteLength(other),
});
check("different content is not deduped", !otherClip.deduped);

/** Re-send existing plaintext, as `clipsync copy` effectively does. */
async function recopy(text: string) {
  return pcApi.createClip({ keyEpoch: EPOCH,
    type: "text", envelope: await encryptText(keys, text),
    contentHash: await dedupeHash(keys, text), size: Buffer.byteLength(text),
  });
}

// TEXT is now buried under otherClip, so copying it again must move it rather
// than create a second row.
const bumped = await recopy(TEXT);
check("re-copying an older clip reuses its id", bumped.deduped && bumped.id === created.id);

const afterBump = await pcApi.listClips(20);
check("the re-copied clip is back on top", afterBump.clips[0]?.id === created.id);
check("re-copying does not duplicate the row",
  afterBump.clips.filter((c) => c.id === created.id).length === 1);

const hashes = afterBump.clips.map((c) => c.contentHash);
check("history holds no duplicate content", new Set(hashes).size === hashes.length);

/**
 * The reason this matters: before global dedupe, deleting a secret and then
 * copying it again silently put it back.
 */
const secret = `hunter2-not-a-real-credential # ${RUN}`;
const secretClip = await recopy(secret);
await pcApi.deleteClip(secretClip.id);
const readded = await recopy(secret);
check("a deleted clip comes back as a new row, not a resurrected one",
  !readded.deduped && readded.id !== secretClip.id);
await pcApi.deleteClip(readded.id);

// A pin older than the first page must still be fetchable on its own, since
// clients list pins at the top.
await pcApi.pinClip(otherClip.id, true);
const firstPage = await pcApi.listClips(1);
const pins = await pcApi.listPinned();
check("an older pin is outside the first page",
  !firstPage.clips.some((c) => c.id === otherClip.id));
check("the pinned listing includes it", pins.clips.some((c) => c.id === otherClip.id));
check("the pinned listing holds only pins, unpaged",
  pins.clips.every((c) => c.pinned) && pins.nextCursor === null);
await pcApi.pinClip(otherClip.id, false);

// Put TEXT back on top so the checks that follow still find it newest.
await recopy(TEXT);

await expectStatus("oversized envelope is refused", () => pcApi.createClip({ keyEpoch: EPOCH,
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
const fromLaptop = await laptopApi.listClips(50);
check("paired device decrypts existing history",
  (await decryptText(laptopKeys,
    fromLaptop.clips.find((c) => c.id === created.id)!.envelope)) === TEXT);

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

const SYNCED = `npm install hono # ${RUN}`;
await pcApi.createClip({ keyEpoch: EPOCH,
  type: "text", envelope: await encryptText(keys, SYNCED),
  contentHash: await dedupeHash(keys, SYNCED), size: Buffer.byteLength(SYNCED),
});
await waitFor(() =>
  received.some((m) => m.type === "clip.created" || m.type === "clip.bumped"));

const pushed = received.find(
  (m) => m.type === "clip.created" || m.type === "clip.bumped");
check("laptop receives the clip pushed by the pc", Boolean(pushed));
if (pushed && (pushed.type === "clip.created" || pushed.type === "clip.bumped")) {
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
const linkedHistory = await linkedApi.listClips(50);
check("linked device decrypts existing history",
  (await decryptText(linkedKeys,
    linkedHistory.clips.find((c) => c.id === created.id)!.envelope)) === TEXT);

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
const phoneHistory = await phoneApi.listClips(50);
check("scanning device decrypts existing history",
  (await decryptText(phoneKeys,
    phoneHistory.clips.find((c) => c.id === created.id)!.envelope)) === TEXT);

let replayRefused = false;
try {
  await claimInvite(new ApiClient(BASE), invite.inviteId, invite.secret, "second-phone", "other");
} catch { replayRefused = true; }
check("an invite works exactly once", replayRefused);

// The server holds the sealed payload and the proof; neither may open it.
check("proof is not the sealing secret",
  (await inviteProof(invite.secret)) !== invite.secret);

console.log("\n--- passphrase authority ---");

// Audit O1: the phone holds the vault key but was never told the passphrase.
// Holding the key is enough to wrap it under a passphrase of its own.
const hijack = await openVault("the phone's own passphrase", phone.credentials.kdfSalt);
const hijackBody = {
  wrappedVaultKey: await wrapVaultKey(hijack.kek, phone.vaultKey),
  authHash: await authHashOf(hijack.authProof),
};
await expectStatus("a device without the passphrase cannot replace it",
  () => phoneApi.putVaultKey(hijackBody), 403);
await expectStatus("nor by offering its own passphrase as the proof",
  () => phoneApi.putVaultKey({ ...hijackBody, authProof: hijack.authProof }), 403);
check("the owner's passphrase still unlocks after the attempt",
  (await unlockVault(pcApi, PASS, pc.kdfSalt, (await pcApi.vaultKey()).wrappedVaultKey))
    .vaultKey === vaultKey);

let wrongCurrentRefused = false;
try {
  await changePassphrase(pcApi, pc.kdfSalt, "not the current one", "anything else");
} catch { wrongCurrentRefused = true; }
check("changing the passphrase needs the current one", wrongCurrentRefused);

console.log("\n--- passphrase rotation ---");

await changePassphrase(pcApi, pc.kdfSalt, PASS, "a brand new passphrase");
const afterRotation = await pcApi.vaultKey();

const withNew = await unlockVault(pcApi, "a brand new passphrase", pc.kdfSalt, afterRotation.wrappedVaultKey);
check("the new passphrase opens the same vault key", withNew.vaultKey === vaultKey);

let oldRejected = false;
try {
  await unlockVault(pcApi, PASS, pc.kdfSalt, afterRotation.wrappedVaultKey);
} catch { oldRejected = true; }
check("the old passphrase no longer unwraps it", oldRejected);

const stillReadable = await pcApi.listClips(20);
const rotatedKeys = await vaultKeysFrom(withNew.vaultKey, pc.kdfSalt);
const readBack = await Promise.all(
  stillReadable.clips.map((c) =>
    decryptText(rotatedKeys, c.envelope).catch(() => null)),
);
check("clips written before the change still decrypt", readBack.includes(TEXT),
  "rotation should re-wrap 32 bytes, not re-encrypt history");

// Put the account back so the suite can be run twice in a row. Without this
// the next run cannot unlock the vault it left behind.
await changePassphrase(pcApi, pc.kdfSalt, "a brand new passphrase", PASS);
const restored = await pcApi.vaultKey();
check("the suite leaves the passphrase as it found it",
  (await unlockVault(pcApi, PASS, pc.kdfSalt, restored.wrappedVaultKey)).vaultKey === vaultKey);

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

await expectStatus("a device cannot revoke itself by id",
  () => pcApi.revokeDevice(pc.deviceId), 400);

// The laptop's socket from the realtime section is still open. Revoking the
// token alone would leave it receiving every new clip.
let revokedCloseCode: number | null = null;
socket.addEventListener("close", (e) => { revokedCloseCode = e.code; });
received.length = 0;

await pcApi.revokeDevice(laptop.deviceId);
await expectStatus("revoked token stops working", () => laptopApi.me(), 401);
check("revocation closes the device's open socket",
  await waitFor(() => revokedCloseCode !== null),
  `socket state ${socket.readyState}`);
check("the close says why", revokedCloseCode === REVOKED_CLOSE_CODE,
  `got close code ${revokedCloseCode}`);
check("the device is told it was revoked before the close",
  received.some((m) => m.type === "revoked"));

const AFTER_REVOKE = `clip made after revocation # ${RUN}`;
await pcApi.createClip({ keyEpoch: EPOCH,
  type: "text", envelope: await encryptText(keys, AFTER_REVOKE),
  contentHash: await dedupeHash(keys, AFTER_REVOKE), size: Buffer.byteLength(AFTER_REVOKE),
});
await new Promise((r) => setTimeout(r, 500));
check("a revoked device receives no further clips",
  !received.some((m) => m.type === "clip.created" || m.type === "clip.bumped"));

socket.close();

console.log("\n--- device lifecycle ---");

// Logout and "Unpair" revoke the device itself, which a device could not do
// before: a forgotten token left the device listed and sealed to by re-keys.
const leaving = await new ApiClient(BASE).bootstrap(ADMIN, `leaving-${RUN}`, "linux");
const leavingApi = new ApiClient(BASE, leaving.token);
await leavingApi.revokeSelf();
await expectStatus("a device can revoke itself", () => leavingApi.me(), 401);
let secondLogout = true;
try { await leavingApi.revokeSelf(); } catch { secondLogout = false; }
check("revoking yourself twice is not an error", secondLogout);
check("a revoked-by-itself device is no longer listed",
  !(await pcApi.devices()).devices.some((d) => d.id === leaving.deviceId));

// Page through the whole history: every clip once, newest first.
const pagedIds: string[] = [];
const pagedTimes: number[] = [];
let cursor: string | number | undefined;
do {
  const page = await pcApi.listClips(7, cursor);
  pagedIds.push(...page.clips.map((c) => c.id));
  pagedTimes.push(...page.clips.map((c) => c.createdAt));
  cursor = page.nextCursor ?? undefined;
} while (cursor !== undefined);
check("paging visits every clip once", new Set(pagedIds).size === pagedIds.length,
  `${pagedIds.length - new Set(pagedIds).size} repeated`);
check("paging stays newest first",
  pagedTimes.every((t, i) => i === 0 || t <= pagedTimes[i - 1]!));

console.log("\n--- envelope v2 ---");

// v2 binds the copying device, copy time and type to the ciphertext, so a
// server cannot present one clip as another's copy. The server here is
// honest, so tampering is simulated on the client's copy of the row.
const pcRing = await ringKeysFrom(ringOf(vaultKey, EPOCH), pc.kdfSalt);
const phoneRingKeys = await ringKeysFrom(ringOf(phone.vaultKey, EPOCH), phone.credentials.kdfSalt);
const V2_TEXT = `sealed with v2 # ${RUN}`;
const v2Created = await pcApi.createClip(await sealText(pcRing, pc.userId, pc.deviceId, V2_TEXT));
const v2Clip = await phoneApi.getClip(v2Created.id);
check("clips are written as v2 envelopes", v2Clip.envelope.startsWith("v2."));
const v2Opened = await readClip(phoneRingKeys, v2Clip, phone.credentials.userId);
check("another device reads a v2 clip", v2Opened.text === V2_TEXT);
check("and learns who copied it, authenticated",
  v2Opened.origin === pc.deviceId && Math.abs(Date.now() - (v2Opened.copiedAt ?? 0)) < 60_000);

const refusedAs = async (clip: typeof v2Clip, account = phone.credentials.userId) =>
  (await readClip(phoneRingKeys, clip, account).catch(() => null)) === null;
check("a v2 clip does not open for another account",
  await refusedAs(v2Clip, "usr_someone_else"));
check("a clip presented as another device's copy is refused",
  await refusedAs({ ...v2Clip, deviceId: phone.credentials.deviceId }));
check("a clip whose dedupe tag was swapped is refused",
  await refusedAs({ ...v2Clip, contentHash: v2Clip.contentHash.replace(/^./, (ch) => (ch === "A" ? "B" : "A")) }));
const otherV2 = await phoneApi.getClip((await pcApi.createClip(
  await sealText(pcRing, pc.userId, pc.deviceId, `another v2 clip # ${RUN}`))).id);
check("one clip's envelope in another clip's row is refused",
  await refusedAs({ ...v2Clip, envelope: otherV2.envelope }));
await expectStatus("the server refuses a v2 envelope naming another device",
  async () => pcApi.createClip(await sealText(pcRing, pc.userId, phone.credentials.deviceId, `forged # ${RUN}`)), 400);

console.log("\n--- images and files ---");

// Bytes are encrypted per file in 1 MiB chunks and kept in R2; the clip's
// envelope holds the file's key, name and digest.
const fileBytes = new Uint8Array(2_500_000).map((_, i) => (i * 31 + Number(RUN)) & 0xff);
const uploaded = await uploadFile(pcApi, pcRing, pc.userId, pc.deviceId, {
  name: `photo-${RUN}.png`,
  mime: "image/png",
  bytes: fileBytes,
});
const fileClip = await phoneApi.getClip(uploaded.id);
check("an image is stored as an image clip with a blob", fileClip.type === "image" && Boolean(fileClip.blobId));
check("its row holds only ciphertext", !fileClip.envelope.includes(`photo-${RUN}`));
const fetched = await downloadFile(phoneApi, phoneRingKeys, fileClip, phone.credentials.userId);
check("another device downloads the same bytes",
  fetched.bytes.length === fileBytes.length && fetched.bytes.every((b, i) => b === fileBytes[i]));
check("with its name and type", fetched.meta.name === `photo-${RUN}.png` && fetched.meta.mime === "image/png");
const firstChunk = await phoneApi.getBlobChunk(fileClip.blobId!, 0);
check("the server holds chunks it cannot read",
  firstChunk.length === 1024 * 1024 + 28 && !firstChunk.subarray(12, 44).every((b, i) => b === fileBytes[i]));

let swappedRefused = false;
try {
  await downloadFile(phoneApi, phoneRingKeys, { ...fileClip, blobId: "blob_other" }, phone.credentials.userId);
} catch { swappedRefused = true; }
check("a clip pointing at another blob is refused", swappedRefused);

const usageBefore = await pcApi.blobUsage();
check("R2 use is counted against the budget",
  usageBefore.classA >= 3 && usageBefore.classB >= 4 && usageBefore.storedBytes > 0);
await pcApi.deleteClip(uploaded.id);
const usageAfter = await pcApi.blobUsage();
check("deleting the clip frees its storage",
  usageAfter.storedBytes === usageBefore.storedBytes - (2_500_000 + 3 * 28));

// Kept through the re-key below, which must re-seal its envelope only.
const survivorBytes = new TextEncoder().encode(`notes kept across a re-key # ${RUN}`);
const survivor = await uploadFile(pcApi, pcRing, pc.userId, pc.deviceId, {
  name: `notes-${RUN}.txt`,
  mime: "text/plain",
  bytes: survivorBytes,
});
const survivorBefore = await pcApi.getClip(survivor.id);
check("a non-image is stored as a file clip", survivorBefore.type === "file");

console.log("\n--- re-key ---");

// The phone (invite) and the linked device register device keys; the pc,
// which runs the re-key, does not, so it is the one reported as left out.
// Test devices are revoked at the end, so runs do not pile up sealed copies.
const phoneDevice = await generateDeviceKeypair(false);
const linkedDevice = await generateDeviceKeypair(false);
check("a device registers its public key",
  await registerDeviceKey(phoneApi, phoneDevice.publicKey));
await registerDeviceKey(linkedApi, linkedDevice.publicKey);

const phoneSocket = new WebSocket(await phoneApi.syncUrl());
const phoneReceived: ServerMessage[] = [];
phoneSocket.addEventListener("message", (e) => {
  phoneReceived.push(JSON.parse(String(e.data)) as ServerMessage);
});
await waitFor(() => phoneReceived.some((m) => m.type === "ready"));

const BEFORE_REKEY = `written before the re-key # ${RUN}`;
const beforeRekey = await pcApi.createClip({ keyEpoch: EPOCH,
  type: "text", envelope: await encryptText(keys, BEFORE_REKEY),
  contentHash: await dedupeHash(keys, BEFORE_REKEY), size: Buffer.byteLength(BEFORE_REKEY),
});

let storedFirst: VaultRing | null = null;
const rekeyed = await rekeyVault(
  pcApi,
  { account: pc.userId, kdfSalt: pc.kdfSalt, ring: ringOf(vaultKey, EPOCH) },
  PASS,
  { onRotated: (ring) => { storedFirst = ring; } },
);
const NEXT = EPOCH + 1;
const newKey = currentKey(rekeyed.ring);
check("re-keying moves the vault to the next epoch", rekeyed.epoch === NEXT);
check("the new key is handed over before history is re-encrypted",
  (storedFirst as VaultRing | null)?.current === NEXT);
check("the new key is a different key", newKey !== vaultKey);
check("a device without a device key is reported as left out",
  rekeyed.unsealed.some((d) => d.id === pc.deviceId));
check("devices with a device key are not",
  !rekeyed.unsealed.some((d) =>
    d.id === phone.credentials.deviceId || d.id === linked.credentials.deviceId));
check("the revoked device is not offered the new key",
  !rekeyed.unsealed.some((d) => d.id === laptop.deviceId));
check("connected devices are told about the re-key",
  await waitFor(() => phoneReceived.some((m) => m.type === "vault.rotated" && m.epoch === NEXT)));

const phoneRing = await refreshVaultRing(
  phoneApi, phoneDevice, phone.credentials.deviceId, ringOf(phone.vaultKey, EPOCH));
check("a device opens its sealed copy of the new key",
  phoneRing.current === NEXT && currentKey(phoneRing) === newKey);
check("and keeps the old key for anything not yet moved",
  phoneRing.keys[String(EPOCH)] === vaultKey);

const linkedSealed = (await linkedApi.sealedVaultKey()).sealed!;
let crossRefused = false;
try {
  await openVaultKeyForDevice(phoneDevice, phone.credentials.deviceId, NEXT, linkedSealed);
} catch { crossRefused = true; }
check("one device's sealed copy does not open for another", crossRefused);

const newKeys = await ringKeysFrom(rekeyed.ring, pc.kdfSalt);
const moved = (await pcApi.getClip(beforeRekey.id));
check("history is re-encrypted under the new key", moved.keyEpoch === NEXT);
check("and still reads the same",
  (await decryptClip(newKeys, moved, pc.userId).catch(() => null)) === BEFORE_REKEY);
check("re-encryption upgrades history to v2 envelopes", moved.envelope.startsWith("v2."));
const oldKeyAsNew = await ringKeysFrom(ringOf(vaultKey, NEXT), pc.kdfSalt);
check("the old key no longer opens it",
  (await decryptClip(oldKeyAsNew, moved, pc.userId).catch(() => null)) === null);

const survivorAfter = await pcApi.getClip(survivor.id);
check("a file survives the re-key under the new key",
  survivorAfter.keyEpoch === NEXT &&
  (await downloadFile(pcApi, newKeys, survivorAfter, pc.userId)).bytes.length === survivorBytes.length);
check("without its bytes in R2 being rewritten", survivorAfter.blobId === survivorBefore.blobId);
await pcApi.deleteClip(survivor.id);

const again2 = await reencryptHistory(pcApi, { account: pc.userId, kdfSalt: pc.kdfSalt, ring: rekeyed.ring });
check("re-encryption is safe to run again", again2.reencrypted === 0);

const bumpedAfter = await pcApi.createClip({
  keyEpoch: NEXT,
  type: "text",
  envelope: await encryptText(newKeys.byEpoch.get(NEXT)!, BEFORE_REKEY),
  contentHash: await dedupeHash(newKeys.byEpoch.get(NEXT)!, BEFORE_REKEY),
  size: Buffer.byteLength(BEFORE_REKEY),
});
check("dedupe still recognises re-encrypted history",
  bumpedAfter.deduped && bumpedAfter.id === beforeRekey.id);

const AFTER_REKEY = `written after the re-key # ${RUN}`;
const afterRekey = await pcApi.createClip({
  keyEpoch: NEXT,
  type: "text",
  envelope: await encryptText(newKeys.byEpoch.get(NEXT)!, AFTER_REKEY),
  contentHash: await dedupeHash(newKeys.byEpoch.get(NEXT)!, AFTER_REKEY),
  size: Buffer.byteLength(AFTER_REKEY),
});
check("the revoked device's key opens nothing written since",
  (await decryptText(laptopKeys, (await pcApi.getClip(afterRekey.id)).envelope)
    .catch(() => null)) === null);

let staleCode = "";
try {
  await pcApi.createClip({
    keyEpoch: EPOCH,
    type: "text", envelope: await encryptText(keys, `stale # ${RUN}`),
    contentHash: await dedupeHash(keys, `stale # ${RUN}`), size: 8,
  });
} catch (e) { staleCode = e instanceof ApiRequestError ? e.code : String(e); }
check("a write under the old key is refused as stale", staleCode === STALE_EPOCH_ERROR,
  `got ${staleCode}`);

check("the passphrase unlocks the new key",
  (await unlockVault(pcApi, PASS, pc.kdfSalt, (await pcApi.vaultKey()).wrappedVaultKey))
    .vaultKey === newKey);

phoneSocket.close();
await pcApi.revokeDevice(phone.credentials.deviceId);
await pcApi.revokeDevice(linked.credentials.deviceId);

// A second account on the same server (decisions §43-§45): made by an admin
// invite, so the suite needs no mail; then it must not reach the first
// account, and its own passphrase signs a new device into it.
console.log("\n--- a second account ---");
const OTHER_EMAIL = `other-${RUN}@example.org`;
const OTHER_PASS = `another account's passphrase ${RUN}`;
const secondInvite = await new ApiClient(BASE).mintSignupInvite(ADMIN);
const second = await new ApiClient(BASE).signup({
  email: OTHER_EMAIL, invite: secondInvite.code, deviceName: `other-${RUN}`, platform: "linux",
});
check("an admin invite makes a second account", second.createdAccount === true && second.userId !== pc.userId);
const secondApi = new ApiClient(BASE, second.token);
const secondVault = await unlockVault(secondApi, OTHER_PASS, second.kdfSalt, second.wrappedVaultKey, true);
check("the second account gets a vault key of its own", Boolean(secondVault.vaultKey) && secondVault.vaultKey !== newKey);

const secondClips = await secondApi.listClips();
check("the second account sees none of the first account's clips",
  !secondClips.clips.some((c) => c.id === afterRekey.id || c.id === beforeRekey.id));
await expectStatus("the second account cannot read the first's clip", () => secondApi.getClip(afterRekey.id), 404);
await expectStatus("the second account cannot revoke the first's device", () => secondApi.revokeDevice(pc.deviceId), 404);
check("the first account's device still works", (await pcApi.me()).deviceId === pc.deviceId);

const { kdfSalt: secondSalt } = await new ApiClient(BASE).signinSalt(OTHER_EMAIL);
check("sign-in finds the second account's salt by email", secondSalt === second.kdfSalt);
await expectStatus("sign-in refuses the wrong passphrase", async () =>
  new ApiClient(BASE).signin({
    email: OTHER_EMAIL, deviceName: `wrong-${RUN}`, platform: "linux",
    authProof: (await openVault("not the passphrase", secondSalt)).authProof,
  }), 403);
const signedIn = await new ApiClient(BASE).signin({
  email: OTHER_EMAIL, deviceName: `signed-in-${RUN}`, platform: "linux",
  authProof: (await openVault(OTHER_PASS, secondSalt)).authProof,
});
const signedInVault = await unlockVault(
  new ApiClient(BASE, signedIn.token), OTHER_PASS, signedIn.kdfSalt, signedIn.wrappedVaultKey,
);
check("the passphrase signs a new device into the second account, with its key",
  signedIn.userId === second.userId && signedInVault.vaultKey === secondVault.vaultKey);
await new ApiClient(BASE, signedIn.token).revokeSelf();

// Export, then deletion (decisions §46): the account goes, with everything
// in it, and the first account is untouched.
const SECOND_TEXT = `the second account's clip # ${RUN}`;
const secondKeys = await vaultKeysFrom(secondVault.vaultKey, second.kdfSalt);
const secondClip = await secondApi.createClip({
  keyEpoch: 0, type: "text",
  envelope: await encryptText(secondKeys, SECOND_TEXT),
  contentHash: await dedupeHash(secondKeys, SECOND_TEXT),
  size: Buffer.byteLength(SECOND_TEXT),
});
const exported = await secondApi.exportAccount();
check("the export holds the account's clips, and only as ciphertext",
  exported.clips.some((c) => c.id === secondClip.id) &&
  !JSON.stringify(exported).includes(SECOND_TEXT) &&
  (await decryptText(secondKeys, exported.clips.find((c) => c.id === secondClip.id)!.envelope)) === SECOND_TEXT);
await expectStatus("deleting needs the passphrase, not just the token", () => secondApi.deleteAccount({}), 400);
await deleteAccountWithPassphrase(secondApi, OTHER_PASS, second.kdfSalt);
await expectStatus("the deleted account's device is gone", () => secondApi.me(), 401);
await expectStatus("the deleted account's passphrase signs nothing in", async () =>
  new ApiClient(BASE).signin({
    email: OTHER_EMAIL, deviceName: `after-${RUN}`, platform: "linux",
    authProof: (await openVault(OTHER_PASS, second.kdfSalt)).authProof,
  }), 403);
check("the first account is untouched by the deletion", (await pcApi.getClip(afterRekey.id)).id === afterRekey.id);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
