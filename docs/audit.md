# Audit — September 2026

A full read of the repository at `1f90880` (v0.1, deployed at clip.rfh.et),
followed by probes against a local Worker to confirm or rule out what the
reading suggested. Every finding below marked *reproduced* was demonstrated
against running code, not inferred.

## Where the project stands

**Built and working.** Text clips, end-to-end encrypted, synced in real time
across a Linux agent, a browser/PWA and a Tauri tray app. Encrypted history
with whole-history dedupe, pinning and 30-day expiry. Four ways to enrol a
device (admin bootstrap, pairing code, ECDH link, scan-to-join invite),
revocation, passphrase rotation over a wrapped vault key, and an Android share
target plus paste box for sending from a phone.

**Health at the time of the audit.**

| Check | Result |
|---|---|
| `npm run typecheck` | passes only with a local `.dev.vars` — fixed, see F6 |
| `npm test` (crypto unit tests) | 38 / 38 |
| `npm run e2e` against `wrangler dev` | 59 / 59 (README said 53) |
| CI | none |
| Worker unit tests | none — `@cloudflare/vitest-pool-workers` is installed but unused |

About 7,800 lines of TypeScript and Rust across four packages and four apps.

**What is genuinely good.** One crypto implementation shared by all three
runtimes, which is the decision most likely to have prevented real bugs. HMAC
dedupe tags instead of plaintext digests. Bearer tokens, pair codes and pickup
tokens hashed at rest. Single-use WebSocket tickets claimed by
`DELETE … RETURNING`. Persist-before-fanout. A Durable Object that hibernates
properly. And `docs/decisions.md`, which records *why* at a level most
projects never reach — it made this audit much faster.

**The pattern in the findings.** Almost everything below sits on a boundary
the design reasons about carefully in one direction and less in the other:
revocation stops new connections but not existing ones; the server never sees
plaintext except in the one URL the share sheet builds; a linked device never
learns the passphrase but can still replace it.

## Fixed on this branch

Each fix has a check that fails against the previous code.

**F1 — High — A revoked device kept receiving clips.** *Reproduced.*
Revocation made the token stop resolving but left the device's open sync
socket alone, so it went on receiving every new clip — and it holds the vault
key that opens them. The revoke handler now has the SyncRoom send a `revoked`
frame and close the device's sockets (code 4001). Three e2e checks.

A detail worth keeping: under local workerd, an idle socket that receives the
server's close never sees its `close` event — the client sits in CLOSING. It
is cut off (verified: no further clips arrive), but it would never learn why.
That is why the explicit frame exists and clients act on it.

**F2 — High (privacy) — Shared text crossed the edge in plaintext.**
*Reproduced.* Android's share target opens `GET /share?text=<clip>`, and the
query string travelled to Cloudflare with the page request, into whatever
request logs sit on the path. This was the one route by which clipboard
plaintext reached the server side at all. The service worker now answers
`/share` navigations with the app shell fetched without the query; the iOS
Shortcut form is `/share#text=` (a fragment is never sent); the page scrubs
the address bar. Verified in headless Chromium: no request for `/share`
reaches the server with the worker installed, one does with it bypassed.

**F3 — Medium — The agent echoed stale clipboard content.** *Reproduced.* A
clipboard read in flight when a remote clip was applied returned the old
content, which no longer matched the echo guard, so the agent pushed it back:
the old clip was bumped onto every other device's clipboard, then the next
poll bumped the new one back. Two spurious uploads per remote clip whenever a
read overlapped. Polls now discard a result that predates an apply, and only
one runs at a time.

**F4 — Medium — A revoked agent retried forever.** *Reproduced.* It kept
reconnecting with a dead token, and the systemd unit restarted it forever
(`StartLimitIntervalSec=0`). It now stops on the revoked frame, close code
4001 or a 401, and exits 78; the unit sets `RestartPreventExitStatus=78`. The
web UI and tray stop reconnecting too and show `revoked`.

**F5 — Low — Clipboard reads could hang.** `xclip -o` waits on the selection
owner and had no timeout, while the poller started a new read every 600 ms.
Reads are bounded at 5 s and a killed read counts as a failure, not an empty
clipboard.

**F6 — Low — Typecheck failed on a clean clone.** The `Env` typings come from
`wrangler types` (gitignored, never run by the script), and `ADMIN_SECRET`
appeared in them only if `.dev.vars` existed.

**F7 — Docs.** The README, `decisions.md` §11 and the approval screen said a
linked device "cannot change the passphrase". It can (O1). Corrected, along
with a stale test count, a duplicated heading and "sealing your passphrase" on
a screen that seals the vault key.

## Open

Ordered by severity. The roadmap ([roadmap.md](roadmap.md)) schedules them.

**O1 — High — Any enrolled device can replace the passphrase.** *Reproduced.*
`PUT /api/vault/key` accepts a new wrapped key from any device, and any device
holding the vault key can produce one. A phone that joined by QR and never
knew the passphrase can therefore set its own and lock the owner out of the
web UI and every `CLIPSYNC_PASSPHRASE` agent. Needs server-side proof of the
current passphrase before a wrapped key is replaced.

**O2 — Medium — Revocation does not rotate the vault key.** A revoked device
keeps the key forever. It can no longer fetch ciphertext, but anything it
obtains later — a database leak, a backup, a malicious operator — it can read.
Accounts migrated from the pre-vault-key scheme have a related, documented
problem: their vault key is still a function of the original passphrase.
Both need a re-key, which needs a way to hand the new key to devices that do
not know the passphrase.

**O3 — Medium — No security headers on the web UI.** *Confirmed.* No
`Content-Security-Policy`, no `frame-ancestors`, no `Referrer-Policy`, on a
page that can hold the vault key in `localStorage`. XSS is the attack that
turns that storage choice into a full compromise, and a CSP is the cheap
defence against it. The tray app already ships one.

**O4 — Medium — Unauthenticated endpoints are not rate limited, and linking
can be blocked by anyone.** *Reproduced.* The link-request flood guard is a
global cap of 20 pending requests, so 20 anonymous POSTs block
`clipsync link` for every user for ten minutes — the audit's own probe did
exactly that and broke the e2e suite until the table was cleared.
`/bootstrap`, `/pair` and `/invites/:id/claim` have no limits at all.

**O5 — Low — Nothing runs the tests automatically.** No CI, and no Worker
unit tests. The e2e suite is good and self-contained, but only runs when
someone remembers.

**O6 — Low — Clips missed while offline are not recovered.** The agent does
not look at history on reconnect, so a laptop that slept through a copy never
receives it. The web UI does not reload on reconnect either (the tray does).

**O7 — Low — Orphaned device rows.** `clipsync logout` and the web UI's
"Unpair" forget the token locally but never revoke it. A wrong passphrase at
`clipsync login`/`pair` fails *after* the device is enrolled. A link approved
but never collected leaves an enrolled device nobody holds the token for.

**O8 — Low — Envelopes are not bound to their row.** AES-GCM is used without
associated data, and clients do not check `contentHash` against the decrypted
text, so the server could swap or replay one of the user's own ciphertexts
under another clip id. It cannot forge content.

**O9 — Low — Invite proofs are stored as presented.** The server stores
`SHA-256(S)` and the claimant presents `SHA-256(S)`, so anyone who can read the
`invites` table during the five-minute window can claim the invite (a device
token, not the vault key). Pair codes and pickup tokens are hashed at rest;
invites should hash the proof once more.

**O10 — Low — Smaller correctness points.**
- The history cursor is `created_at` alone; two clips in the same millisecond
  can be skipped across a page boundary. Use `(created_at, id)`.
- `ids.ts` says pair codes have "~50 bits"; eight base-32 characters are 40.
  Still fine for single-use and ten minutes, but only while O4 is open does
  the difference start to matter.
- The expiry cron deletes clips without telling open clients.
- The tray app's debug log is `/tmp/clipsync-desktop.log`, created with the
  default umask — readable by other local users. It holds URLs, device names
  and errors, not clip content.
- `npm ci` warns the lockfile is damaged, though it installs correctly.
  Regenerating it is cheap.

## Method

Every source file was read in full. The probes that turned suspicions into
findings ran against `wrangler dev` with a local D1 database: a TypeScript
script for the API-level findings, headless Chromium (Playwright) for the
share target and service worker, and the real agent binary driven through a
fake `xclip` on `PATH` for the daemon's timing bugs, with a configurable read
delay to hold a read open across a remote apply. Each fixed finding was
checked twice: failing against the original code, then passing against the
fix.
