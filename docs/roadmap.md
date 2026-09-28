# Roadmap

What comes after v0.1, in order, and why in that order. Finding numbers
(O1, O2, …) refer to [audit.md](audit.md).

## Order, and the reason for it

The README's "not built yet" list leads with images. The next phase should not.

1. **Phase 2 — Trust boundaries.** Fix what the audit left open in the
   security model: who may change the passphrase, what revocation actually
   revokes, and what the web UI and the unauthenticated endpoints expose.
2. **Phase 3 — Reliability.** Missed clips, orphaned devices, paging.
3. **Phase 4 — Beyond text on Linux.** Images and files, other platforms, a
   global picker.

Three reasons trust comes before images:

- **Re-keying gets more expensive with every byte under the key.** Rotating
  the vault key means re-encrypting history. Today that is at most 30 days of
  text in D1. After images it is blobs in R2. Build rotation while it is
  cheap.
- **The envelope format should change once.** Images need a binary envelope.
  Binding envelopes to their row (O8) needs associated data. Both are a `v2`
  envelope, and both should land in the same one.
- **O1 is live on a deployed instance.** Any device that has ever been
  enrolled can lock the owner out. Images are a feature; this is a hole.

## Phase 2 — Trust boundaries

Five milestones, each one PR, each shippable alone. 2.0 and 2.1 are the
recommended next piece of work.

### 2.0 CI

Every later milestone changes the protocol, so it should land behind checks
that run without anyone remembering to.

- GitHub Actions on push and pull request: `npm ci`, `npm run typecheck`,
  `npm test`, then `wrangler dev` with local D1 migrations and `npm run e2e`.
  The e2e suite is already self-contained and re-runnable against one
  database.
- Regenerate `package-lock.json` in the same PR (`npm ci` reports it damaged).
- Start Worker unit tests with `@cloudflare/vitest-pool-workers`, which is
  already a dependency: first for `routes/vault.ts`, since 2.1 changes it.

*Done when:* a PR shows green typecheck, unit and e2e jobs.

### 2.1 Passphrase authority (O1)

Only someone who knows the current passphrase may replace the wrapped vault
key.

**Design.** Add a third HKDF branch off the PBKDF2 master, beside the KEK:

    auth = HKDF(master, salt, "clipsync:auth:v1")        32 bytes
    server stores  users.auth_hash = SHA-256(auth)

`PUT /api/vault/key` on an account that already has a wrapped key requires
`{ wrappedVaultKey, authProof, newAuthHash }`. The server writes in one
statement, `UPDATE users SET … WHERE id = ? AND auth_hash = SHA-256(authProof)`,
so a wrong proof and a lost race both come back as zero rows changed and a
403. The first write (new account, legacy migration) sets `auth_hash`
alongside the key, as today.

**Why this adds no new attack.** The server already holds the wrapped key,
which tests a passphrase guess offline at the same PBKDF2 cost. `auth_hash`
is no better an oracle. `auth` itself reaches the server only during a
rotation, and it is an HKDF branch independent of the KEK, so it opens
nothing.

**Existing accounts.** They have a wrapped key but no `auth_hash`. The next
passphrase unlock sets it (`POST /api/vault/auth`, accepted only while it is
NULL). Until then the hole stays open, so the release notes should tell the
owner to unlock once with the passphrase — the web UI, or
`clipsync status` with `CLIPSYNC_PASSPHRASE` set.

**Visible change.** `clipsync passphrase` asks for the current passphrase. A
device that never knew it cannot rotate, which is what the docs claimed all
along.

**Touches:** `packages/crypto/src/index.ts` (`openVault` returns `auth`),
`packages/client/src/vault.ts`, `apps/worker/src/routes/vault.ts`, migration
`0005`, `apps/agent/src/cli.ts`, `apps/web/src/session.ts`.

*Done when:* e2e shows an invite-joined device's `PUT` refused with 403, the
owner rotating with the current passphrase, the TOFU claim working exactly
once, and every existing check still passing. A unit test shows `auth`
differs from both the KEK and the legacy vault key.

### 2.2 Web security headers (O3)

A `_headers` file in `apps/web/public`, which Workers static assets honours:

    Content-Security-Policy: default-src 'self'; script-src 'self';
      style-src 'self'; img-src 'self' data:; connect-src 'self';
      frame-ancestors 'none'; base-uri 'none'; form-action 'self'
    Referrer-Policy: no-referrer
    X-Content-Type-Options: nosniff
    Permissions-Policy: camera=(), microphone=(), geolocation=()

Two things to verify rather than assume: that `connect-src 'self'` admits the
same-origin `wss:` socket in Safari as well as Chromium (older WebKit did
not), and that nothing in the React tree sets inline styles through an
attribute rather than the CSSOM.

*Done when:* a Playwright pass over every screen — pair, unlock, workspace,
link approval, join, share — records no `securitypolicyviolation` events, and
the live socket connects on an iPhone.

### 2.3 Abuse limits (O4, O9)

- A Workers rate-limiting binding keyed by `CF-Connecting-IP` on the four
  unauthenticated writes: `/auth/bootstrap` (strict, e.g. 5/min),
  `/devices/pair`, `/invites/:id/claim` and `/link/request` (e.g. 10/min).
- Replace the global cap of 20 pending link requests with a per-IP cap, so
  one client can no longer block linking for everyone.
- Store invites' proof as `SHA-256(proof)`, like every other credential. This
  is the same migration and the same endpoints.

*Done when:* e2e shows a flood from one address refused while a second
address can still link, and an invite claimed with the value stored in the
table rejected.

### 2.4 Device keys and re-key (O2)

The largest milestone, and the one that makes revocation mean what it says.

**The problem it solves.** Rotating the vault key is easy for devices that
know the passphrase — they unwrap the new one. Devices enrolled by link or
invite do not know it, and that was the point of those flows. So a re-key
today would strand every phone. The new key needs a path to each device that
does not go through the passphrase.

**Design.**

- Each device holds a long-term P-256 ECDH keypair, generated at enrolment.
  The private key stays on the device: in the agent config (0600), and in the
  web UI as a non-extractable `CryptoKey` in IndexedDB. The public key is
  stored on the device row. Existing devices register one on next start.
- `users.key_epoch` counts vault keys; each clip records the epoch it was
  written under.
- A re-key runs on a device that holds the passphrase (it has to rewrap under
  the KEK, and 2.1 requires proof). It:
  1. generates vault key *n+1*;
  2. re-encrypts history page by page — decrypt, encrypt, recompute the
     dedupe tag — through a bulk endpoint that accepts only rows still at
     epoch *n*;
  3. seals the new key to every active device's public key, with the device
     id bound into the HKDF info, the same construction as `link.ts`;
  4. wraps it under the passphrase and advances the epoch.
- While a re-key is running, writes at the old epoch get a 409. No clip is
  stored under a retired key after the switch.
- A device that sees a newer epoch fetches its sealed copy, opens it and
  carries on. A revoked device has no sealed copy.
- Surfaces: `clipsync devices --revoke <id> --rekey`, a matching choice in the
  web UI's revoke flow, and `clipsync rekey`, which also retires the
  passphrase-derived key of migrated accounts (the caveat in the README's
  "Changing the passphrase" section).

*Done when:* e2e revokes a device and re-keys, then shows that the revoked
device's old key cannot open new clips, that clips from before the re-key are
still readable by the remaining devices, and that an invite-joined phone
keeps working without being re-invited.

## Phase 3 — Reliability

Smaller, independent items. Any order.

- **Catch-up on reconnect (O6).** The agent reads the newest clip after each
  reconnect and applies it if it is newer than the last one handled. It only
  applies clips from the last few minutes, because a clip from yesterday
  arriving on wake is surprising rather than helpful. The web UI reloads
  history on reconnect and on `visibilitychange`, as the tray already does.
- **No orphan devices (O7).** `clipsync logout` and the web UI's "Unpair"
  revoke the device first. `login` and `pair` check the passphrase before
  enrolling, or revoke on failure. The expiry cron revokes devices whose link
  approval was never collected.
- **Paging (O10).** Cursor on `(created_at, id)`.
- **Expiry events (O10).** The cron broadcasts `clip.deleted` for what it
  purges.
- **Tray log (O10).** Moves to `$XDG_STATE_HOME/clipsync/desktop.log` at 0600.

## Phase 4 — Beyond text on Linux

What the README lists as not built yet, after the foundations above.

- **Envelope v2.** Binary payloads, and AES-GCM associated data binding each
  envelope to its user and to a client-chosen clip nonce, so the server can
  no longer swap one ciphertext for another (O8). Clients also check the
  dedupe tag against the decrypted text.
- **Images and files.** R2 for the blobs, D1 keeps the row and a v2 envelope
  for the metadata, and `ClipType` gains `"image"` and `"file"`. Chunked
  upload above the 256 KB envelope limit. Expiry and re-key both have to
  cover R2, which is the reason re-key comes first.
- **macOS and Windows agents.** `pbpaste`/`pbcopy` and a PowerShell backend
  behind the existing `ClipboardBackend` interface, and a launchd plist to go
  with the systemd unit.
- **Global picker.** A `Ctrl+Shift+V` shortcut in the tray app that opens the
  panel at the pointer, with keyboard selection.
