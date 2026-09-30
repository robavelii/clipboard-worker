# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Owner's rules

- **No attribution, anywhere.** No `Co-Authored-By:` or `Claude-Session:` trailers on commits, no "Generated with Claude Code" line or footer in PR descriptions, PR comments or merge commit messages. Some tools append a footer server-side: after creating a PR, re-read it and strip any that appeared.
- **Plans stay out of the repo.** Audits, roadmaps, proposals and other suggestions go in shared docs (artifacts), not in files committed here. The repo holds code, the README, and `docs/decisions.md`: the *why* behind decisions already built.
- **Record real decisions in `docs/decisions.md`.** Use the numbered-section style already there: what was chosen, what the alternatives cost, and any trap worth recording. Add an entry when a change makes a real design choice, not for routine fixes.
- Commit subjects follow `type(scope): summary`, e.g. `fix(worker): …`, `feat(agent): …`, `docs: …`. Bodies explain why.
- **Commit authorship.** Feature work (`feat`, `perf`, `docs` for a feature, and `fix`es to how the product behaves) is authored *and* committed as the owner: `git -c user.name="Robel Fekadu" -c user.email="robelfekadu@gmail.com" commit …`. Routine automated work keeps the Claude identity: CI repairs, test-only fixes, fixes for a failing check, and chores. Releases are tags the owner pushes.

## What this is

ClipSync: end-to-end encrypted clipboard sync for one person's devices. Live at clip.rfh.et. Cloudflare Worker (Hono) + D1 + a Durable Object, a Node CLI/daemon, a React web UI/PWA served from the Worker's own origin, and a Tauri tray app. **The server only ever sees ciphertext**; every design choice below follows from that.

## Commands

npm workspaces monorepo; run from the root.

```bash
npm install
npm run typecheck              # every workspace; the worker's runs `wrangler types` first
npm test                       # crypto, Worker and agent unit tests (vitest 4)
npm test -w @clipsync/crypto -- test/link.test.ts      # one file
npm test -w @clipsync/crypto -- -t "wrong passphrase"  # one test by name
npm test -w @clipsync/worker -- test/vault.test.ts     # Worker tests: run in workerd via @cloudflare/vitest-pool-workers
npm run build                  # web UI + agent bundle (apps/agent/dist/clipsync.mjs)
npm run build:binary           # standalone agent for this machine (apps/agent/dist/bin/<os>-<arch>/clipsync)
```

Local Worker (builds the web UI, then serves it and the API on :8787):

```bash
cp apps/worker/.dev.vars.example apps/worker/.dev.vars   # set ADMIN_SECRET
npm run db:migrate:local
npm run dev
```

End-to-end suite: about 95 checks against the running local Worker, with real crypto and WebSockets, standing in for several devices:

```bash
npm run e2e    # needs `npm run dev` running; ADMIN_SECRET must match CLIPSYNC_ADMIN_SECRET (default "local-dev-admin-secret")
```

It is one script (`scripts/e2e.ts`), with no per-test filter. It re-runs against the same local database, so fixtures are tagged per run and looked up by id, never by list position. If link tests fail with "too many pending link requests", unapproved requests from earlier local runs filled the per-address cap (3 pending; all local requests share one address); clear them:

```bash
cd apps/worker && npx wrangler d1 execute clipsync --local --command "DELETE FROM link_requests"
```

Agent and tray:

```bash
npm run build -w @clipsync/agent && node apps/agent/dist/clipsync.mjs status
npm run build -w @clipsync/desktop     # tray: MUST go through the Tauri CLI (see below)
scripts/install-agent.sh               # from a checkout: builds, `clipsync install`, tray autostart; re-run after a pull to upgrade
clipsync install [--dry-run]           # the service alone, for whichever clipsync runs it (binary or bundle)
```

Deploy (production): CI does it on every push to `main` that passes, running `npm run db:migrate` then `npm run deploy` with the `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` secrets (decisions §30). By hand: the same two commands. **Migrations run while the old Worker is still live, so they must only add** (new tables, new nullable or defaulted columns): a Worker that the migration breaks is live until the deploy finishes.

Worker unit tests (`apps/worker/test/`) call the real Worker through `SELF.fetch`, with a fresh D1 per test file and every migration applied (`test/apply-migrations.ts`). The pool bundles its own workerd, which trails wrangler's, so `vitest.config.ts` pins an older `compatibilityDate` for tests; bump it when the pool catches up.

CI (`.github/workflows/ci.yml`) runs typecheck + unit tests, and the e2e suite against `npm run dev` followed by the Linux binary enrolling and sending a file, on every push to `main` and every PR; on `main` a `deploy` job follows. `.github/workflows/release.yml` builds and runs the five standalone binaries on their own runners for PRs that touch the agent, and on a `v*` tag publishes them with `SHA256SUMS` to a GitHub Release (decisions §29).

The one-command installers are `scripts/install.sh` (POSIX sh: everything in `main()`, called last, so a truncated `curl | sh` runs nothing) and `scripts/install.ps1` (PowerShell 5.1 and 7). The Worker bundles them as text (`rules` in `wrangler.jsonc`) and serves them at `/install.sh` and `/install.ps1` (`src/routes/install.ts`, in `run_worker_first`), replacing `__CLIPSYNC_URL__` with its own origin and `__CLIPSYNC_REPO__` with the `RELEASES_REPO` var. Each downloads a release archive, checks it against `SHA256SUMS`, runs `clipsync link` if not enrolled, then `clipsync install` (decisions §33). The Release workflow runs them on its macOS and Windows runners against a local copy of the job's own archive.

The standalone agent is a Node single executable (`apps/agent/build-binary.mjs`): the CLI bundled as CommonJS, turned into a blob and injected into a copy of `node` with postject. Code that needs its own file path must go through `runningFile()` in `cli.ts`, because `import.meta.url` does not exist in the CommonJS bundle. A binary replaced on disk triggers the same exit-75 restart as a rebuilt bundle, so it must be replaced by rename: overwriting a running executable fails on Linux ("Text file busy").

## Architecture

```
packages/protocol   wire types + constants (sync events, close codes, limits)
packages/crypto     WebCrypto-only envelope crypto: runs unchanged in Worker, browser, Node
packages/client     typed API client + the shared flows (vault, link, invite)
packages/react      useClips / useSync hooks, shared by web UI and tray
apps/worker         Hono API, SyncRoom Durable Object, hourly purge cron, R2 blobs, serves apps/web/dist
apps/web            React UI / PWA (share target, service worker)
apps/agent          `clipsync` CLI + clipboard daemon (Linux: wl-clipboard or xclip)
apps/desktop        Tauri tray panel (Ctrl+Alt+V picker)
```

The shared packages exist so one implementation of each flow runs on all three surfaces. A change to envelope framing, KDF parameters, HKDF info strings or a handshake belongs in `packages/crypto` or `packages/client`, never re-implemented in an app.

### Key hierarchy (`packages/crypto/src/index.ts`)

```
passphrase --PBKDF2(salt, 600k)--> master --HKDF("clipsync:kek:v1")--> KEK --wraps--> vault key (32 random bytes)
                                          `--HKDF("clipsync:auth:v1")--> authProof (server keeps SHA-256 = users.auth_hash)
vault key --HKDF("clipsync:enc:v1")----> AES-GCM-256 (clip envelopes "v2.<header>.<iv>.<ct>", AAD = account + header; legacy "v1.<iv>.<ct>")
vault key --HKDF("clipsync:dedupe:v1")-> HMAC-SHA256 (contentHash: dedupe tag, never a bare digest)
device key (P-256) <--ECDH-- re-key seals each new vault key to it ("d1.", crypto/device.ts)
```

- The server stores only the salt, the *wrapped* vault key (`k1.…`) and `auth_hash`.
- **Replacing the wrapped key needs the current passphrase's `authProof`** (`PUT /api/vault/key`); only the first wrap is exempt. Devices joined by link or invite hold the vault key but not the passphrase, so they can read but never rotate (decisions §19). Accounts predating proofs register one on first passphrase unlock (`POST /api/vault/auth`, first use wins); `unlockVault` does this every time and reports `proofConflict`.
- Devices hold the vault key, not the passphrase. Agent: `~/.config/clipsync/config.json` (0600). Web: sessionStorage, or localStorage if opted in.
- **Key epochs** (decisions §22). `users.key_epoch` and `clips.key_epoch`; a device holds a ring of keys by epoch (`packages/client/src/ring.ts`), decrypts each clip with `decryptClip`, and writes only under the current key, naming it as `keyEpoch`. The server refuses a write under an older epoch with 409 `stale_epoch`, so every write path must pass `keyEpoch` and handle that by refreshing the ring.
- **Device keys.** Every device registers a P-256 public key (`PUT /api/devices/me/key`). Agent and tray keep the keypair in their config file; the browser keeps a non-extractable one in IndexedDB. `rekeyVault` (`packages/client/src/rekey.ts`) rotates in one guarded batch (`POST /api/vault/rotate`: epoch bump, new wrapped key, a sealed copy per active device), then re-encrypts history with conditional writes (`POST /api/clips/reencrypt`), resumable via `reencryptHistory`. Devices pick up their copy (`GET /api/vault/sealed`) on `vault.rotated`, a 409, a clip under a newer epoch, or startup. No copy, or one they cannot open, is `NoSealedKeyError`: the agent exits 78, a browser falls back to the passphrase.
- **Legacy accounts** (created before the vault key existed) use `legacyVaultKey = PBKDF2 master` as their vault key, which keeps old clips decryptable. `unlockVault` in `packages/client/src/vault.ts` owns that rule; don't duplicate it.
- Envelope prefixes are versioned (`v1`/`v2`, `k1`, `l1`, `i1`, `d1`). A format change is a new prefix, never an in-place change.
- **Clip envelopes are v2** (decisions §24). The header names the copying device, the copy time and the type, and AES-GCM's associated data binds it and the account id to the ciphertext. Write clips with `sealText` and read them with `readClip`/`decryptClip` (`packages/client/src/ring.ts`), never with raw `encryptText`/`decryptText`. `readClip` also refuses a v2 clip whose header disagrees with its row, or whose dedupe tag is not its plaintext's. The Worker checks a v2 header names the writing device. A bump replaces the stored envelope, and re-encryption writes v2, so a re-key upgrades history. v1 stays readable but unauthenticated.

### Enrolling a device (four paths, all ending in a hashed bearer token)

| Path | Who shows what | Secret transfer |
| --- | --- | --- |
| `bootstrap` | first device, `ADMIN_SECRET` | passphrase typed |
| pair code `PAIR-XXXX-XXXX` | trusted device mints, 10 min, single use | passphrase typed |
| link (`crypto/link.ts`) | *joining* device shows QR with its ECDH pubkey; approver checks the 6-digit fingerprint | vault key sealed via ECDH P-256; both pubkeys bound into the HKDF info |
| invite (`crypto/invite.ts`) | *trusted* device shows QR carrying secret S (URL fragment); phone scans | vault key sealed under HKDF(S); server keeps SHA-256(S) |

Secrets always travel in URL **fragments** (`/link#…`, `/join#…`), which browsers never send to the server.

### Sync

- `POST /api/clips` **persists to D1 first**, then fans out via the `SyncRoom` DO (`ctx.waitUntil`). There is one SyncRoom per user. Every D1 query is a trip to one region, so the write path reads and inserts in a single `DB.batch` (decisions §31): add a query to it rather than a separate `await`.
- The WebSocket authenticates with a 30-second single-use ticket (`POST /api/sync/ticket`, claimed by `DELETE … RETURNING`), because browsers can't set headers on a handshake.
- SyncRoom uses the **Hibernation API**: all per-socket state lives in `serializeAttachment`, never in instance fields. Pings are answered by `setWebSocketAutoResponse` without waking the object.
- Fan-out **excludes the origin device**. That is why the tray panel is enrolled as its own device ("<name> (tray)", token in `~/.config/clipsync/tray.json`). If it shared the agent's identity, it would never see local copies (decisions §18).
- Dedupe is across the whole history. A repeat `contentHash` bumps the existing row (`clip.bumped`) instead of inserting. A repeat of the newest clip is a silent no-op.
- Revocation: `DELETE /api/devices/:id` revokes the token (and drops its sealed keys), and `SyncRoom.disconnect` sends a `{type:"revoked"}` frame and closes with `REVOKED_CLOSE_CODE` (4001). Clients treat that frame, code 4001, or a 401 as terminal and stop reconnecting. The frame is needed because under local workerd an idle socket's close event may never fire.
- `GET /api/clips?pinned=1` returns every pin unpaged. `useClips` merges it into the first page, and `sortForDisplay` puts pins first in both UIs.
- **Images and files** (decisions §26): the client encrypts them per file (`packages/client/src/files.ts`) in 1 MiB chunks (AAD = blob id, index, count), under a random key that travels only in the clip's v2 envelope with name, MIME, size and SHA-256 (`FileMeta`). Flow: `POST /api/blobs` reserves room, `PUT /api/blobs/:id/:idx` uploads each chunk, then `POST /api/clips` with `blobId` adopts the blob once every chunk is in. Deleting, expiring or re-copying a clip deletes its R2 objects. A re-key re-seals only the envelope. The agent daemon syncs copied images through the clipboard and sends files copied in a file manager (decisions §27, §28), but applies only images (≤ 5 MB) to the clipboard, never other files; the tray only lists them.
- **R2 budget** (`apps/worker/src/r2.ts`): the Worker is the only thing that touches the bucket, so it counts every billed operation per UTC month in `r2_usage` *before* making it, and refuses past the `vars` budgets with 429 `r2_budget`. Storage is a ceiling on bytes held: `reserveBlob` evicts the oldest unpinned files, and refuses only when pinned files fill it. Any new R2 call must go through `spend()`. Worker tests run with tiny budgets (`vitest.config.ts`).
- Unpinned clips expire after 30 days, images and files after 7 (hourly cron, `apps/worker/src/purge.ts`), and the cron broadcasts `clip.deleted` for each, from origin `server:expiry`. The same purge revokes devices enrolled by link approvals nobody collected.
- History pages on `(created_at, id)`: `nextCursor` is `<createdAt>.<id>`, and a bare timestamp from older clients still works.
- `DELETE /api/devices/me` revokes the calling device. `logout`, the web UI's "Unpair", and a `login`/`pair` whose passphrase fails all call it, so no device is left listed that nobody holds.

### Agent daemon (`apps/agent/src/daemon.ts`)

It polls the clipboard every 600 ms. Echo suppression is the whole design problem, and there are four guards:

1. ignore events from its own `origin` (and, separately, never apply a v2 clip whose authenticated copy time is over 10 minutes old: that is a replay, not a copy);
2. `lastHandled` = the hash of whatever it last pushed *or* applied;
3. the `applied` generation counter drops a read that was in flight when a remote clip was written;
4. the settle rule: push only after the content holds for two consecutive polls.

Clipboard backends (`apps/agent/src/clipboard.ts`): `wl-clipboard` or `xclip` on Linux, `pbpaste`/`pbcopy` on macOS (forced to a UTF-8 locale, since launchd starts jobs without one), and on Windows one long-lived PowerShell helper that answers `R`/`W <base64>` requests on stdin. That avoids starting PowerShell every poll; it also normalises CRLF to LF on read, or applied clips would echo back. `CLIPSYNC_CLIPBOARD` forces a backend. The real helper script runs in the agent tests when `CLIPSYNC_TEST_PWSH` points at a `pwsh` and `DISPLAY` is set (PowerShell 7 on Linux uses xclip).

Images and files (decisions §27, §28): backends may implement `readImage`/`writeImage` (bytes plus a MIME type from their `imageTypes`) and `readFiles` (local paths from a file manager's copy). Linux backends list what the owner offers first and ask for a named type: a plain-text flavour for text, never `text/html` (a browser's "Copy image" offers it beside the picture). New text is checked once, when it settles, for files behind it (a file manager's text is only their paths) and, if it is a lone URL, for an image (Firefox). With no text, the poller looks for files, then an image, every third poll (and on the very next poll once one has been seen, to settle it); tags are `img:<sha256>` and `files:<sha256>` in the same echo guard. Every image up to `MAX_FILE_BYTES` is uploaded; only those ≤ 5 MB are applied. After writing an image the daemon re-reads it, because Windows re-encodes every image as PNG; the Windows helper answers `OK =` when the clipboard has not changed since its last image read, sparing the re-encode. The X11 backend checks `TARGETS` before reading text: xclip, as the owner of an image, answers a text request with the image's bytes. `CLIPSYNC_IMAGES=off` and `CLIPSYNC_FILES=off` disable each.

Reads time out after 5 s; writes don't, and settle on the tool's `exit`, not `close`: `xclip -i`/`wl-copy` fork a selection-holding child that keeps the inherited stdio open until the next copy.

**The service** (`apps/agent/src/service.ts`, decisions §32): `clipsync install` writes a systemd user unit, a launchd plist or a Task Scheduler task (UTF-16 XML via `schtasks`), after copying a standalone binary to `~/.local/bin` or `%LOCALAPPDATA%\Programs\clipsync`. Task Scheduler cannot act on exit codes, so the Windows task runs `clipsync supervise` under `conhost --headless`: it restarts `clipsync run` by systemd's rules and logs to `%LOCALAPPDATA%\clipsync\clipsync.log`. The agent under it exits when the supervisor's stdin pipe closes, so killing the supervisor leaves no orphan. `run` with no config exits 78, so a service installed before enrolment waits instead of looping; enrolling (`enrol()` in `cli.ts`) restarts an installed service. The generated definitions are validated in tests by `systemd-analyze verify`, `plistlib` and `xmllint` where installed; the Release workflow installs and removes the real service on its macOS and Windows runners.

**Updates** (`apps/agent/src/update.ts`, decisions §34): a supervised release binary checks `<releases>/latest` a minute after start and daily, and `clipsync update` does so on demand. `<releases>` is baked in at build time (`__CLIPSYNC_RELEASES__`, from `GITHUB_REPOSITORY`; `CLIPSYNC_RELEASES` overrides it locally), **never taken from the Worker**: a server that could name the next binary would own every device. The update downloads `clipsync-<target>.gz`, checks it against the release's `SHA256SUMS`, runs it with `--version` to confirm it is that release, swaps it in with `replaceExecutable` (`self.ts`), and exits 75. Only release builds update, only forwards. Every request carries `x-clipsync-agent: <build>`; the Worker's `agentGate` refuses writes (426 `agent_outdated`) from releases older than the `MIN_AGENT_VERSION` var, except the socket ticket, the device's own key and its logout, and the daemon answers by updating. `CLIPSYNC_AUTO_UPDATE=off` stops the automatic checks. `apps/agent/test/fake-releases.mjs` stands in for GitHub releases in tests and in the Release workflow, which updates a running v0.0.1 build to v0.0.2 on every platform.

After a reconnect (not on first start) the daemon applies the newest clip if it is another device's, under 10 minutes old, newer than the last local copy and not already on the clipboard (decisions §23). Exit codes, which the systemd unit depends on:

- **75:** the bundle was rebuilt on disk; restart onto it (`RestartForceExitStatus=75`).
- **78:** the device was revoked, re-keyed without a copy for it, or never enrolled; never restart (`RestartPreventExitStatus=78`).
- Under launchd (`CLIPSYNC_SUPERVISOR=launchd`, set by the plist `scripts/install-agent.sh` writes on macOS) that exit is 0 instead, because launchd's `KeepAlive` restarts every failure and cannot exclude one status.

A re-key changes the key every dedupe hash is taken under, so `refresh()` re-primes `lastHandled` under the new key when the epoch moves.

### Web UI (`apps/web`)

Same origin as the API, so there are **no CORS headers anywhere, by design**. `apps/web/public/_headers` sets a strict CSP (`'self'` only, no `unsafe-inline`), `frame-ancestors 'none'` and `no-referrer`. The build has no inline script or style and no component sets a `style` attribute; keep it that way, or the CSP blocks it. API calls from the web UI pass `""` as the base URL: shared client code must resolve paths the way `ApiClient` does, since `new URL(path, "")` throws. Routing is by path in `App.tsx`: `/join#` (invite), `/link#` (approval), `/share` (share target), `/phone` (phone setup). The service worker exists for PWA installability and so that nothing shared reaches the network before it is encrypted (decisions §35). The share sheet POSTs a form (text, links, files); `public/sw.js` answers it *without forwarding it*, keeps it in IndexedDB (`clipsync-shares`, read and deleted through `src/shares.ts`, which must name the same database) and redirects to `/share?pending=<id>`, where the page seals and uploads it. Older installs GET `/share?text=`, answered without the query. The iOS Shortcut uses `/share#text=`; everything after `text=` is the text. Don't add `/share` to `run_worker_first`: Workers Logs would record a `?text=` URL. The service worker deliberately caches nothing. On touch-first devices (`pointer: coarse`) the workspace adds a paste dock and a "Copy latest" card (`src/clipboard.ts`, `src/Latest.tsx`). A clipboard read or write must be called straight from the tap, with nothing awaited before it, or iOS refuses it: an image copy hands `ClipboardItem` a promise of the bytes.

### Tray app (`apps/desktop`)

- Build with `npm run build -w @clipsync/desktop` (the Tauri CLI). `cargo build` produces a binary that points at the Vite dev server and fails only at runtime.
- The webview origin is `tauri://localhost`, so HTTP goes through the Tauri HTTP plugin (`ApiClient`'s `fetchImpl`). WebSockets are unaffected.
- Adding a Worker host means updating **both** the allowlist in `src-tauri/capabilities/default.json` and the CSP in `src-tauri/tauri.conf.json`.
- Tauri v2 silently denies any command not granted in `capabilities/`.
- Debug log: `$XDG_STATE_HOME/clipsync/desktop.log` (default `~/.local/state/clipsync/desktop.log`), 0600.

## Invariants to preserve

- Nothing the server stores or relays may be plaintext or a key: envelopes, HMAC tags, wrapped/sealed keys and public keys only. `scripts/e2e.ts` asserts no plaintext appears in any API response.
- Tokens, pair codes, pickup tokens and tickets are stored as SHA-256 digests; single-use claims are a conditional `UPDATE`/`DELETE … RETURNING`, so the write *is* the mutex.
- The Worker imports `@clipsync/crypto` for types and non-secret helpers only. It never holds a vault key.
- `workers_dev: false`: `wrangler.jsonc` binds the custom domain as the only public door.
- `apps/worker/worker-configuration.d.ts` is generated (`wrangler types`), so don't edit it. Secrets the Worker reads are declared by hand in `apps/worker/src/secrets.d.ts`.

### Abuse limits

The unauthenticated endpoints (`bootstrap`, `pair`, invite `claim`, `link/request`) are rate-limited per client address through the `STRICT_LIMIT` / `UNAUTH_LIMIT` bindings (`src/limits.ts`, `wrangler.jsonc`), keyed by `CF-Connecting-IP`. **Limiting is skipped when that header is missing or a loopback address**, so e2e and local runs are never throttled: Worker tests send none, and local workerd (`wrangler dev`) fills in `127.0.0.1` from the connection. The edge always sends the client's real address. Worker tests that exercise limits set it explicitly, with a fresh address per test (`freshAddress()`), because limiter state is not reset between tests. Invite proofs are hashed again at rest, so the `invites` table never holds what a claimant presents.

## Known open issues

These are tracked in the shared audit and roadmap docs, not in this repo. Don't re-describe them in commits as new discoveries.

- Revocation does not re-key by itself: it takes `clipsync rekey` (or `devices --revoke <id> --rekey`), which needs the passphrase. Only the CLI offers it.
