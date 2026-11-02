---
title: Architecture
description: The pieces of ClipSync, and what happens between a copy on one device and a paste on another.
---

# Architecture

ClipSync is one server and three kinds of client, built from shared packages so
that every client runs the same code for everything that matters.

## The pieces

| Piece | Where | What it is |
| --- | --- | --- |
| Server | `apps/worker` | the API (Hono), a sync room per account, an hourly cleanup, the web app's files |
| Server on Node | `apps/server` | the same API on Node: SQLite, files on disk, no Cloudflare |
| Agent and CLI | `apps/agent` | `clipsync`: the clipboard daemon and every command |
| Web app | `apps/web` | React, served from the server's own origin; installs on a phone |
| Tray panel | `apps/desktop` | Tauri, on Linux |
| `packages/crypto` | | every cipher, key derivation and envelope, on WebCrypto alone |
| `packages/client` | | the typed API client and each flow: unlock, link, invite, re-key, files |
| `packages/protocol` | | wire types and constants |
| `packages/react` | | the history and sync hooks the web app and tray share |

`packages/crypto` runs unchanged in the Worker, in browsers and in Node. One
implementation of the envelope format, not three hand-written ones, is how the
cryptography stays correct.

On Cloudflare the server is a Worker with a D1 database (accounts, devices,
ciphertext clips), a Durable Object per account (live sync), and an R2 bucket
(encrypted file chunks). The Node server runs the same code, handing it objects shaped
like those: SQLite with D1's semantics, a directory for R2, in-process rooms.
The end-to-end suite runs against both on every change.

## A copy, end to end

1. **You copy** on your laptop. The agent hears the clipboard change, waits for
   it to settle, and reads it.
2. **It encrypts** the text under the account's vault key, into an envelope
   whose header says which device copied it, when, and what kind of clip it
   is. The header is authenticated with the ciphertext and bound to the
   account. It also computes a dedupe tag: an HMAC of the text under another
   key derived from the vault key.
3. **It posts** the envelope, the tag and the key epoch to `/api/clips`. The
   server checks the token, that the header names this device and that the
   epoch is current, and stores the row. Database first, always: a clip is
   never announced before it is stored.
4. **The sync room fans out** a `clip.created` event to every other connected
   device of the account, never back to the laptop.
5. **Your desktop's agent** receives it, decrypts it, checks the header agrees
   with the row and the tag with the plaintext, and writes it to the clipboard.
   It remembers what it wrote, so that write isn't read back as a new copy.
6. **You paste.** Typically about 150 ms after the copy.

A device that was offline catches up from history when it reconnects.

## Images and files

A file is encrypted on the device under a random key of its own, in 1 MiB
chunks, each bound to its file, its position and the count. The device reserves
room (`POST /api/blobs`), uploads the chunks, then posts a clip whose envelope
carries the file's key, name, type, size and digest. The server sees chunks and
a size. Deleting or expiring the clip deletes the chunks.

## Keys

```
passphrase ──PBKDF2, 600k──► master ──HKDF──► key-encryption key ──wraps──► vault key (random)
                                     └─HKDF──► passphrase proof (the server keeps its SHA-256)

vault key ──HKDF──► AES-GCM-256    clip envelopes
          ──HKDF──► HMAC-SHA256    dedupe tags
```

The server stores the salt, the wrapped vault key and a hash of the proof.
Every device holds the vault key itself, so only devices that know the
passphrase can change it, but any device can read. Each device also has a
P-256 key pair; a re-key seals the new vault key to each device's public key.
The [security model](security.md) has the detail.

## Joining devices

Every way of joining ends with a device holding a bearer token (stored on the
server as a digest) and the vault key. The two QR flows move the vault key
without the passphrase: an **invite** seals it under a secret that exists only
in the QR, and a **link** seals it to a throwaway key the joining device shows,
checked by a six-digit fingerprint. Both secrets travel in the URL's fragment,
which a browser never sends to a server.

## The web app's origin

The web app is served from the API's own origin, so there is no cross-origin
access to configure and none to get wrong. Its pages carry a strict Content
Security Policy: scripts and styles from this origin only, nothing inline, no
framing. A page that can hold the vault key must not be able to run injected
script. These docs follow the same policy.

## Repository layout

```
packages/protocol   wire types and constants
packages/crypto     envelope encryption: one implementation, three runtimes
packages/client     the API client and shared flows
packages/react      hooks for the web app and tray
apps/worker         the Worker: API, sync room, cleanup, static files
apps/server         the same server on Node, and in the clipsync binary
apps/web            the web app, and these docs (apps/web/docs)
apps/agent          the clipsync CLI and daemon
apps/desktop        the tray panel
scripts/            installers, the end-to-end suite
deploy/server/      setting up a server on Ubuntu
docs/decisions.md   why each design choice was made
```

`docs/decisions.md` records the reasoning behind each decision: what was chosen,
what the alternatives cost, and the traps.
