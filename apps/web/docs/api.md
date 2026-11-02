---
title: HTTP API
description: The server's endpoints, for anyone writing a client. Every body that carries a clip or a key is ciphertext.
---

# HTTP API

The agent, the web app and the tray all use this API through one shared client,
`packages/client`. Writing your own client means doing the cryptography those
clients do, with `packages/crypto`: the server rejects nothing for being
plaintext, but it never decrypts anything either. Treat the wire types in
`packages/protocol` as the precise reference; this page is the map.

## Conventions

- JSON bodies, `content-type: application/json`.
- **Authentication:** `Authorization: Bearer <device token>`. Endpoints marked
  *open* below need none. The server stores tokens only as SHA-256 digests.
- **Errors** are JSON with a status: 400 bad input, 401 no or revoked token,
  403 wrong secret or proof, 404 not found, 409 conflict, 413 too large, 426
  agent too old, 429 rate limited or over budget, 503 not available here (for
  example signup without mail).
- **Key epochs.** Every write of a clip names the `keyEpoch` it was encrypted
  under. A write under an older epoch than the account's is refused with 409
  `stale_epoch`: fetch the new key (`GET /api/vault/sealed`) and retry.
- Agents send `x-clipsync-agent: <version>`. Writes from releases older than
  the server's minimum get 426 `agent_outdated`.

## Health and installers

| Method | Path | |
| --- | --- | --- |
| GET | `/api/health` | *open.* `{"ok": true}` when the server answers |
| GET | `/install.sh`, `/install.ps1` | *open.* the installers, filled in with this server's address |

## Accounts

| Method | Path | |
| --- | --- | --- |
| POST | `/api/auth/bootstrap` | *open.* the first account and device, with the admin secret |
| GET | `/api/auth/me` | this device and its account |
| GET | `/api/signup` | *open.* whether open signup is available |
| POST | `/api/signup/email` | *open.* mail a six-digit code to an address |
| POST | `/api/signup/invites` | *open, admin secret.* mint a signup invite |
| POST | `/api/signup` | *open.* make an account with a code or an invite |
| POST | `/api/signin/salt` | *open.* the salt to derive an address's proof |
| POST | `/api/signin` | *open.* enrol a device with email and the passphrase's proof |
| GET | `/api/account/plan` | the account's plan and usage |
| POST | `/api/account/email/code` | mail a code to a new address |
| PUT | `/api/account/email` | set the address: the code and the passphrase's proof |
| GET | `/api/account/export` | every clip, as ciphertext |
| POST | `/api/account/deletion-code` | mail a code that confirms deletion |
| DELETE | `/api/account` | delete the account: the passphrase's proof or the code |
| POST | `/api/account/passphrase-reset` | operator reset: the admin secret and this device |

## Vault keys

| Method | Path | |
| --- | --- | --- |
| GET | `/api/vault/key` | the salt, the wrapped vault key and the key epoch |
| PUT | `/api/vault/key` | replace the wrapped key: needs the current passphrase's proof |
| POST | `/api/vault/auth` | register a passphrase proof (older accounts; first one wins) |
| POST | `/api/vault/rotate` | re-key: new epoch, new wrapped key, a sealed copy per device |
| GET | `/api/vault/sealed` | this device's sealed copies of newer keys |

## Recovery key

| Method | Path | |
| --- | --- | --- |
| GET | `/api/account/recovery` | whether there is one, and the epoch it opens |
| PUT | `/api/account/recovery` | set or replace it: needs the passphrase's proof |
| DELETE | `/api/account/recovery` | remove it: needs the passphrase's proof |
| POST | `/api/recovery/open` | *open.* fetch what the recovery key unwraps, by email |
| POST | `/api/recovery/reset` | *open.* a new wrapped key, proven by the recovery key |

## Devices

| Method | Path | |
| --- | --- | --- |
| GET | `/api/devices` | the account's devices |
| PATCH | `/api/devices/:id` | rename one |
| DELETE | `/api/devices/:id` | revoke one; its sockets are closed |
| DELETE | `/api/devices/me` | revoke this device (sign out) |
| PUT | `/api/devices/me/key` | register this device's P-256 public key |
| POST | `/api/devices/pair-code` | mint a pairing code |
| POST | `/api/devices/pair` | *open.* enrol with a pairing code |
| POST | `/api/invites` | store a QR invite: the vault key sealed under its secret |
| POST | `/api/invites/:id/claim` | *open.* claim an invite with its proof; enrols a device |
| POST | `/api/link/request` | *open.* a joining device posts its public key |
| GET | `/api/link/:id` | an approver reads the request |
| POST | `/api/link/:id/approve` | approve: the vault key sealed to the joining device |
| POST | `/api/link/:id/claim` | *open.* the joining device collects its token and key, once |

## Clips

| Method | Path | |
| --- | --- | --- |
| POST | `/api/clips` | store a clip: envelope, dedupe tag, type, `keyEpoch`, optional `blobId` |
| GET | `/api/clips` | history, newest first; `?cursor=` pages, `?pinned=1` every pin |
| GET | `/api/clips/:id` | one clip |
| DELETE | `/api/clips/:id` | delete it, with its file |
| POST | `/api/clips/:id/pin` | pin or unpin |
| POST | `/api/clips/reencrypt` | rewrite up to 50 clips under the new key, conditionally |

A clip whose dedupe tag matches one already stored moves that clip to the top
instead of adding another.

## Files

| Method | Path | |
| --- | --- | --- |
| GET | `/api/blobs/usage` | the server's storage and operation budgets this month |
| POST | `/api/blobs` | reserve room for a file of a given size and chunk count |
| PUT | `/api/blobs/:id/:idx` | upload one encrypted chunk (1 MiB of plaintext) |
| GET | `/api/blobs/:id/:idx` | download one chunk |
| DELETE | `/api/blobs/:id` | abandon an upload |

After the last chunk, `POST /api/clips` with the `blobId` makes it a clip.

## Live sync

| Method | Path | |
| --- | --- | --- |
| POST | `/api/sync/ticket` | a single-use ticket, valid 30 seconds |
| GET | `/api/sync/ws?ticket=` | the WebSocket |

Browsers can't set headers on a WebSocket handshake, so the socket
authenticates with a ticket rather than the token. Over it the server sends:

| Event | When |
| --- | --- |
| `clip.created` | another device stored a clip |
| `clip.bumped` | a repeat copy moved a clip to the top |
| `clip.deleted` | deleted, or expired |
| `clip.pinned` | pinned or unpinned |
| `vault.rotated` | the account was re-keyed: fetch your sealed copy |
| `device.connected`, `device.disconnected` | presence |
| `revoked` | this device was revoked; the socket closes with code 4001 |

A device is never sent its own events. Send `{"type":"ping"}` to keep the
socket alive; the server answers without waking anything.
