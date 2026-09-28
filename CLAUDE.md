# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Owner's rules

- **No attribution, anywhere.** No `Co-Authored-By:` or `Claude-Session:` trailers on commits, no "Generated with Claude Code" line or footer in PR descriptions, PR comments or merge commit messages. Some tools append a footer server-side: after creating a PR, re-read it and strip any that appeared.
- **Plans stay out of the repo.** Audits, roadmaps, proposals and other suggestions go in shared docs (artifacts), not in files committed here. The repo holds code, the README, and `docs/decisions.md`: the *why* behind decisions already built.
- **Record real decisions in `docs/decisions.md`.** Use the numbered-section style already there: what was chosen, what the alternatives cost, and any trap worth recording. Add an entry when a change makes a real design choice, not for routine fixes.
- Commit subjects follow `type(scope): summary`, e.g. `fix(worker): …`, `feat(agent): …`, `docs: …`. Bodies explain why.

## What this is

ClipSync: end-to-end encrypted clipboard sync for one person's devices. Live at clip.rfh.et. Cloudflare Worker (Hono) + D1 + a Durable Object, a Node CLI/daemon, a React web UI/PWA served from the Worker's own origin, and a Tauri tray app. **The server only ever sees ciphertext**; every design choice below follows from that.

## Commands

npm workspaces monorepo; run from the root.

```bash
npm install
npm run typecheck              # every workspace; the worker's runs `wrangler types` first
npm test                       # crypto + Worker unit tests (vitest 4)
npm test -w @clipsync/crypto -- test/link.test.ts      # one file
npm test -w @clipsync/crypto -- -t "wrong passphrase"  # one test by name
npm test -w @clipsync/worker -- test/vault.test.ts     # Worker tests: run in workerd via @cloudflare/vitest-pool-workers
npm run build                  # web UI + agent bundle (apps/agent/dist/clipsync.mjs)
```

Local Worker (builds the web UI, then serves it and the API on :8787):

```bash
cp apps/worker/.dev.vars.example apps/worker/.dev.vars   # set ADMIN_SECRET
npm run db:migrate:local
npm run dev
```

End-to-end suite: about 66 checks against the running local Worker, with real crypto and WebSockets, standing in for several devices:

```bash
npm run e2e    # needs `npm run dev` running; ADMIN_SECRET must match CLIPSYNC_ADMIN_SECRET (default "local-dev-admin-secret")
```

It is one script (`scripts/e2e.ts`), with no per-test filter. It re-runs against the same local database, so fixtures are tagged per run and looked up by id, never by list position. If link tests fail with "too many pending link requests", something filled the global pending-link cap; clear it:

```bash
cd apps/worker && npx wrangler d1 execute clipsync --local --command "DELETE FROM link_requests"
```

Agent and tray:

```bash
npm run build -w @clipsync/agent && node apps/agent/dist/clipsync.mjs status
npm run build -w @clipsync/desktop     # tray: MUST go through the Tauri CLI (see below)
scripts/install-agent.sh               # builds, installs systemd user service + tray autostart; re-run after a pull to upgrade
```

Deploy (production): `npm run deploy`. Migrations: `npm run db:migrate` (remote).

Worker unit tests (`apps/worker/test/`) call the real Worker through `SELF.fetch`, with a fresh D1 per test file and every migration applied (`test/apply-migrations.ts`). The pool bundles its own workerd, which trails wrangler's, so `vitest.config.ts` pins an older `compatibilityDate` for tests; bump it when the pool catches up.

CI (`.github/workflows/ci.yml`) runs typecheck + unit tests, and the e2e suite against `npm run dev`, on every push to `main` and every PR.

## Architecture

```
packages/protocol   wire types + constants (sync events, close codes, limits)
packages/crypto     WebCrypto-only envelope crypto: runs unchanged in Worker, browser, Node
packages/client     typed API client + the shared flows (vault, link, invite)
packages/react      useClips / useSync hooks, shared by web UI and tray
apps/worker         Hono API, SyncRoom Durable Object, hourly purge cron, serves apps/web/dist
apps/web            React UI / PWA (share target, service worker)
apps/agent          `clipsync` CLI + clipboard daemon (Linux: wl-clipboard or xclip)
apps/desktop        Tauri tray panel (Ctrl+Alt+V picker)
```

The shared packages exist so one implementation of each flow runs on all three surfaces. A change to envelope framing, KDF parameters, HKDF info strings or a handshake belongs in `packages/crypto` or `packages/client`, never re-implemented in an app.

### Key hierarchy (`packages/crypto/src/index.ts`)

```
passphrase --PBKDF2(salt, 600k)--> master --HKDF("clipsync:kek:v1")--> KEK --wraps--> vault key (32 random bytes)
                                          `--HKDF("clipsync:auth:v1")--> authProof (server keeps SHA-256 = users.auth_hash)
vault key --HKDF("clipsync:enc:v1")----> AES-GCM-256 (clip envelopes "v1.<iv>.<ct>")
vault key --HKDF("clipsync:dedupe:v1")-> HMAC-SHA256 (contentHash: dedupe tag, never a bare digest)
```

- The server stores only the salt, the *wrapped* vault key (`k1.…`) and `auth_hash`.
- **Replacing the wrapped key needs the current passphrase's `authProof`** (`PUT /api/vault/key`); only the first wrap is exempt. Devices joined by link or invite hold the vault key but not the passphrase, so they can read but never rotate (decisions §19). Accounts predating proofs register one on first passphrase unlock (`POST /api/vault/auth`, first use wins); `unlockVault` does this every time and reports `proofConflict`.
- Devices hold the vault key, not the passphrase. Agent: `~/.config/clipsync/config.json` (0600). Web: sessionStorage, or localStorage if opted in.
- **Legacy accounts** (created before the vault key existed) use `legacyVaultKey = PBKDF2 master` as their vault key, which keeps old clips decryptable. `unlockVault` in `packages/client/src/vault.ts` owns that rule; don't duplicate it.
- Envelope prefixes are versioned (`v1`, `k1`, `l1`, `i1`). A format change is a new prefix, never an in-place change.

### Enrolling a device (four paths, all ending in a hashed bearer token)

| Path | Who shows what | Secret transfer |
| --- | --- | --- |
| `bootstrap` | first device, `ADMIN_SECRET` | passphrase typed |
| pair code `PAIR-XXXX-XXXX` | trusted device mints, 10 min, single use | passphrase typed |
| link (`crypto/link.ts`) | *joining* device shows QR with its ECDH pubkey; approver checks the 6-digit fingerprint | vault key sealed via ECDH P-256; both pubkeys bound into the HKDF info |
| invite (`crypto/invite.ts`) | *trusted* device shows QR carrying secret S (URL fragment); phone scans | vault key sealed under HKDF(S); server keeps SHA-256(S) |

Secrets always travel in URL **fragments** (`/link#…`, `/join#…`), which browsers never send to the server.

### Sync

- `POST /api/clips` **persists to D1 first**, then fans out via the `SyncRoom` DO (`ctx.waitUntil`). There is one SyncRoom per user.
- The WebSocket authenticates with a 30-second single-use ticket (`POST /api/sync/ticket`, claimed by `DELETE … RETURNING`), because browsers can't set headers on a handshake.
- SyncRoom uses the **Hibernation API**: all per-socket state lives in `serializeAttachment`, never in instance fields. Pings are answered by `setWebSocketAutoResponse` without waking the object.
- Fan-out **excludes the origin device**. That is why the tray panel is enrolled as its own device ("<name> (tray)", token in `~/.config/clipsync/tray.json`). If it shared the agent's identity, it would never see local copies (decisions §18).
- Dedupe is across the whole history. A repeat `contentHash` bumps the existing row (`clip.bumped`) instead of inserting. A repeat of the newest clip is a silent no-op.
- Revocation: `DELETE /api/devices/:id` revokes the token, and `SyncRoom.disconnect` sends a `{type:"revoked"}` frame and closes with `REVOKED_CLOSE_CODE` (4001). Clients treat that frame, code 4001, or a 401 as terminal and stop reconnecting. The frame is needed because under local workerd an idle socket's close event may never fire.
- `GET /api/clips?pinned=1` returns every pin unpaged. `useClips` merges it into the first page, and `sortForDisplay` puts pins first in both UIs.
- Unpinned clips expire after 30 days (hourly cron, `apps/worker/src/index.ts`).

### Agent daemon (`apps/agent/src/daemon.ts`)

It polls the clipboard every 600 ms. Echo suppression is the whole design problem, and there are four guards:

1. ignore events from its own `origin`;
2. `lastHandled` = the hash of whatever it last pushed *or* applied;
3. the `applied` generation counter drops a read that was in flight when a remote clip was written;
4. the settle rule: push only after the content holds for two consecutive polls.

Reads time out after 5 s; writes don't, because `xclip -i`/`wl-copy` fork a selection-holding child. Exit codes, which the systemd unit depends on:

- **75:** the bundle was rebuilt on disk; restart onto it (`RestartForceExitStatus=75`).
- **78:** the device was revoked; never restart (`RestartPreventExitStatus=78`).

### Web UI (`apps/web`)

Same origin as the API, so there are **no CORS headers anywhere, by design**. `apps/web/public/_headers` sets a strict CSP (`'self'` only, no `unsafe-inline`), `frame-ancestors 'none'` and `no-referrer`. The build has no inline script or style and no component sets a `style` attribute; keep it that way, or the CSP blocks it. API calls from the web UI pass `""` as the base URL: shared client code must resolve paths the way `ApiClient` does, since `new URL(path, "")` throws. Routing is by path in `App.tsx`: `/join#` (invite), `/link#` (approval), `/share` (share target). The service worker exists for PWA installability and to answer `/share` navigations *without forwarding the query string*, so shared plaintext never leaves the phone. The iOS Shortcut uses `/share#text=`. The service worker deliberately caches nothing.

### Tray app (`apps/desktop`)

- Build with `npm run build -w @clipsync/desktop` (the Tauri CLI). `cargo build` produces a binary that points at the Vite dev server and fails only at runtime.
- The webview origin is `tauri://localhost`, so HTTP goes through the Tauri HTTP plugin (`ApiClient`'s `fetchImpl`). WebSockets are unaffected.
- Adding a Worker host means updating **both** the allowlist in `src-tauri/capabilities/default.json` and the CSP in `src-tauri/tauri.conf.json`.
- Tauri v2 silently denies any command not granted in `capabilities/`.
- Debug log: `/tmp/clipsync-desktop.log`.

## Invariants to preserve

- Nothing the server stores or relays may be plaintext or a key: envelopes, HMAC tags, wrapped/sealed keys and public keys only. `scripts/e2e.ts` asserts no plaintext appears in any API response.
- Tokens, pair codes, pickup tokens and tickets are stored as SHA-256 digests; single-use claims are a conditional `UPDATE`/`DELETE … RETURNING`, so the write *is* the mutex.
- The Worker imports `@clipsync/crypto` for types and non-secret helpers only. It never holds a vault key.
- `workers_dev: false`: `wrangler.jsonc` binds the custom domain as the only public door.
- `apps/worker/worker-configuration.d.ts` is generated (`wrangler types`), so don't edit it. Secrets the Worker reads are declared by hand in `apps/worker/src/secrets.d.ts`.

## Known open issues

These are tracked in the shared audit and roadmap docs, not in this repo. Don't re-describe them in commits as new discoveries.

- Revocation does not rotate the vault key.
- No rate limiting on unauthenticated endpoints; the link-request cap is global.
