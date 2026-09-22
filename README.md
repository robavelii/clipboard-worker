# ClipSync

**Live at [clip.rfh.et](https://clip.rfh.et)**

Encrypted clipboard sync across your own machines. Copy on one device, paste on
another. Built on Cloudflare Workers, D1 and Durable Objects.

The Worker never sees your clipboard. Text is encrypted on the device that
copied it and decrypted on the device that pastes it; what reaches Cloudflare is
an opaque ciphertext envelope.

```
  PC agent ────┐                    ┌─ Worker (Hono)  ── D1   (ciphertext history)
               ├── HTTPS / WSS ─────┤
  Laptop agent ┤                    └─ SyncRoom DO    ── WebSocket fan-out
               │
  Browser ─────┘                       static assets  ── React UI (same origin)
```

## Status

v0.1 — text clips, real-time sync, encrypted history, device pairing and
revocation. Images and files are not implemented; see [Not built yet](#not-built-yet).

## Quick start (local)

```bash
npm install
```

```bash
npm run db:migrate:local
```

Set a local admin secret in `apps/worker/.dev.vars` (copy `.dev.vars.example`),
then run the Worker — this builds the web UI and serves it from the same origin
as the API:

```bash
npm run dev
```

In a second terminal, enrol this machine and start syncing:

```bash
npm run build -w @clipsync/agent
```

```bash
node apps/agent/dist/clipsync.mjs login --url http://127.0.0.1:8787
```

```bash
node apps/agent/dist/clipsync.mjs run
```

Copy something. It appears at http://127.0.0.1:8787 and on every other paired
device.

To use the deployed instance instead, point the agent at it:

```bash
node apps/agent/dist/clipsync.mjs login --url https://clip.rfh.et
```

## Deploy

Already deployed to `clip.rfh.et`. To stand up your own instance:

```bash
npx wrangler login
```

Create the database and paste the printed `database_id` into
`apps/worker/wrangler.jsonc`:

```bash
npm run db:create
```

```bash
npm run db:migrate
```

Set the admin secret — this is what authorises the very first device:

```bash
npx wrangler secret put ADMIN_SECRET --config apps/worker/wrangler.jsonc
```

```bash
npm run deploy
```

`wrangler.jsonc` binds the Worker to `clip.rfh.et` as a custom domain and sets
`workers_dev: false` — one public door, not two. Change the `routes` entry for
your own hostname, or set `workers_dev: true` to use the generated
`*.workers.dev` URL instead.

## Adding a device

The first device authenticates with `ADMIN_SECRET`. Every later device joins
with a single-use pairing code, valid for ten minutes:

```bash
clipsync pair-code
```

Then on the new machine:

```bash
clipsync pair PAIR-XXXX-XXXX --url https://clip.rfh.et
```

The browser pairs the same way — open the Worker URL and paste a code.

**Every device must use the same encryption passphrase.** It is the only key to
your history; nothing on the server can recover it. A device that pairs with the
wrong passphrase will see existing clips as locked, and both the CLI and the web
UI warn you at pair time rather than letting you discover it later.

## CLI

| Command | Purpose |
|---|---|
| `clipsync login --url <url>` | Create the account and enrol this device |
| `clipsync pair <code> --url <url>` | Join with a pairing code |
| `clipsync pair-code` | Mint a code for another device |
| `clipsync run` | Watch the clipboard and sync (the daemon) |
| `clipsync history [-n 20]` | Recent clips, decrypted locally |
| `clipsync copy <clip-id>` | Put an old clip back on this clipboard |
| `clipsync devices [--revoke <id>]` | List or revoke devices |
| `clipsync status` | Config, clipboard backend, token validity |
| `clipsync logout` | Forget local credentials |

`clipsync run` does not push whatever happened to be on the clipboard when it
started; pass `--push-current` if you want that.

### Running it as a service

```ini
# ~/.config/systemd/user/clipsync.service
[Unit]
Description=ClipSync clipboard agent
After=graphical-session.target

[Service]
ExecStart=%h/path/to/clipsync/apps/agent/dist/clipsync.mjs run
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now clipsync
```

## Security model

What the design actually protects against, and what it does not.

**Protected.** Someone who obtains your D1 database, your R2 bucket or your
Cloudflare account sees ciphertext and HMAC tags. They cannot read your clips,
and they cannot confirm a guess ("was this clip `hunter2`?") because the dedupe
tag is an HMAC under a key they do not hold, not a plain digest.

**Key derivation.** `PBKDF2-SHA256`, 600k iterations, over a per-account random
salt, then HKDF into two subkeys: `AES-GCM-256` for content and `HMAC-SHA256`
for dedupe tags. The salt is public; the passphrase never leaves the device.

**Tokens.** Device tokens are 256-bit random strings stored only as SHA-256
digests. Revoking a device invalidates its token immediately. The WebSocket uses
a separate single-use 30-second ticket, because browsers cannot set headers on a
handshake and a long-lived token in a URL ends up in logs.

**Not protected.** The agent stores your passphrase in `~/.config/clipsync/config.json`
at mode 0600 so it can start unattended. Anyone who can read that file can also
read your clipboard directly, so this does not weaken the threat model the
encryption addresses — but it does mean local disk compromise is game over. Set
`CLIPSYNC_PASSPHRASE` instead if you would rather keep it out of the file.

The server also learns metadata it cannot avoid: how many clips you make, when,
from which device, and roughly how large they are.

## Retention

Clips expire after 30 days and an hourly cron deletes them. Pinned clips never
expire. Clipboard history accumulates API tokens and passwords whether or not
you intend it to, so the default is to forget.

## Repository layout

```
packages/protocol   Wire types shared by all three surfaces
packages/crypto     Envelope encryption — one implementation, three runtimes
packages/client     Typed API client shared by the agent and the web UI
apps/worker         Hono API, SyncRoom Durable Object, cron, static assets
apps/web            React + Vite UI, served by the Worker
apps/agent          Node CLI and clipboard daemon
scripts/e2e.ts      End-to-end smoke test against a running Worker
```

The shared packages exist because the same envelope format has to be produced
and consumed by a Worker, a browser and a Node process. Three hand-written
implementations of the same AES-GCM framing is where crypto bugs come from.

## Tests

```bash
npm run test
```

Unit tests for the crypto envelope — round-trips, tampering, wrong passphrase,
and the property that dedupe tags differ across passphrases.

```bash
npm run e2e
```

Twenty-nine checks against a running `npm run dev`: bootstrap, pairing,
single-use codes and tickets, dedupe, size limits, live WebSocket delivery,
revocation, and an explicit assertion that no plaintext appears in any API
response.

## Not built yet

Images and file sync (needs R2), mobile, a global `Ctrl+Shift+V` picker,
semantic search, and non-Linux clipboard backends. `packages/crypto` and the
`ClipType` union are the two places that will need to change first for images.

Search is deliberately client-side: the server holds ciphertext, so there is
nothing for SQL `LIKE` to match. Server-side search needs a blind index or
encrypted vector search — a separate design decision, not an incremental one.
