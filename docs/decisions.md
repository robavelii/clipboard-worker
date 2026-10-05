# Design decisions

Why this differs from the original plan, and what the alternatives cost.

## 1. End-to-end encryption in v0.1, not phase 8

The original plan deferred encryption until after images and files. Deferring it
has two costs that compound:

- **Migration.** Every clip written before the switch is plaintext in D1. Turning
  on encryption later means either abandoning that history or writing a one-off
  re-encryption pass that has to run on a device that holds the key.
- **Search.** Phase 10 specified `GET /api/clips?q=`, backed by SQL. That query
  cannot survive the switch to ciphertext. Building it first means building it
  twice.

Doing it first costs one thing: search moves to the client. That is a real
limitation and it is documented, not hidden.

## 2. HMAC dedupe tags, not a plaintext digest

Deduplication needs a stable per-content identifier that the server can compare.
The obvious choice is `SHA-256(plaintext)`.

That choice silently undoes the encryption for any *guessable* clip. Clipboard
history is full of guessable content — a git command, a known URL, a common
password. Anyone holding the database can hash a candidate and check for a
match, which is a confirmation oracle over exactly the content most worth
protecting.

`HMAC(dedupe_key, plaintext)` keeps dedupe working — it is deterministic per
account — while making the tag meaningless to anyone without the key. The dedupe
key is a separate HKDF branch from the encryption key, so one never substitutes
for the other.

## 3. A TypeScript agent

The plan proposed Python for the agent, on the grounds of familiarity and easy
clipboard libraries.

The agent is not primarily a clipboard program; it is the third implementation
of an envelope format that also has to be produced by a Worker and consumed by a
browser. Two languages means the AES-GCM framing, the base64url variant, the
HKDF info strings and the PBKDF2 parameters all exist twice, and a mismatch
shows up as "this clip will not decrypt on my laptop" rather than as a test
failure.

`packages/crypto` is one file, using nothing but WebCrypto, and it runs
unmodified in all three places. The clipboard part — the bit Python would have
made easier — is 90 lines of shelling out to `xclip` or `wl-copy`.

## 4. Pairing codes instead of OAuth

The system serves one person. Email means deliverability; OAuth means
registering an application and handling callbacks. Both are more infrastructure
than the thing they protect.

Instead: the first device proves itself with a Wrangler secret, and every later
device redeems a single-use ten-minute code minted by an already-trusted device.
The browser is not a special case — it pairs exactly like a laptop does, so
there is one authentication path to reason about rather than two.

## 5. Single-use tickets for the WebSocket

Browsers cannot attach an `Authorization` header to a WebSocket handshake. The
common workarounds are a token in the query string or a cookie.

A long-lived token in a URL ends up in access logs, proxy logs and browser
history. So the socket gets its own credential: `POST /api/sync/ticket` over an
authenticated HTTP request returns a 30-second, single-use ticket. Claiming it
is a `DELETE ... RETURNING`, so the delete *is* the claim and a replay finds
nothing.

## 6. Persist before fan-out

`POST /api/clips` writes to D1 and only then asks the Durable Object to
broadcast, via `ctx.waitUntil` so the write is not on the response path.

The ordering matters on failure. A client that misses the push can still recover
the clip from history on its next poll or reconnect. A clip that was broadcast
but never stored is gone for anyone who was offline.

## 7. Two guards against echo loops

Writing a received clip to the local clipboard is indistinguishable, to a
clipboard watcher, from the user copying it. Without care, two devices trade a
single copy back and forth forever.

- Events carry an `origin` device id, and the Durable Object already excludes it
  from fan-out. The agent checks it again anyway.
- The agent records the dedupe tag of whatever it last uploaded *or* applied, so
  the poll that immediately follows a write recognises the content and stays
  quiet.

The second guard is the load-bearing one; the first is defence in depth. The
server adds a third: a clip whose tag matches the newest clip is not stored
again, which also absorbs the duplicate events that clipboard managers emit
constantly.

## 8. Hibernation-friendly keepalives

The `SyncRoom` Durable Object uses the WebSocket Hibernation API and registers
`setWebSocketAutoResponse` for the ping frame. Sockets stay open while the
object is evicted from memory, and a keepalive is answered by the runtime
without waking it — so an idle fleet of devices costs nothing but the
connections themselves.

This is why all connection state lives in each socket's attachment rather than
in instance fields: instance fields do not survive hibernation.

## 9. Expiry by default

Clipboard history accrues API tokens, passwords and private URLs whether or not
you meant it to. Unpinned clips expire after 30 days and an hourly cron removes
them. A clipboard manager that remembers everything forever is a credential
store nobody audits.

## 10. Device linking transfers the secret, it does not re-derive it

Pairing codes work but ask the user to type the passphrase again on every new
machine, which is both annoying and the step where people quietly get it wrong
and end up with a device that shows their whole history as locked.

The fix is a key agreement, not a better prompt. The joining device generates a
throwaway ECDH keypair; the approving device derives a shared secret and seals
the passphrase to it. The server relays two public keys and one ciphertext, and
cannot derive the shared secret from public keys alone.

**What the QR is actually for.** Not convenience — authentication. A relay that
can choose which public key the approver sees can substitute its own, read the
secret, and re-seal it. Carrying the joining device's key out of band, through a
camera or a human paste, removes that choice. Both ends then display a
fingerprint of the key so a mismatch is visible. `approveLink` also compares the
key the server returned against the one that arrived out of band and refuses
outright if they differ, so the human check is a backstop rather than the only
defence.

**What is transferred.** The passphrase itself, not raw key material. That is a
deliberate simplification: the agent already stores the passphrase at mode 0600
so it can start unattended, so transferring it adds no local exposure.

The cleaner long-term shape is a random vault key wrapped by a
passphrase-derived KEK — it would let you change the passphrase without
re-encrypting history. That is worth doing when passphrase rotation becomes a
requirement; it is not worth the migration today.

**Where the secret briefly rests.** Between approval and pickup the server holds
the new device's bearer token in the clear, for at most ten minutes, in a row
that cannot be read without the pickup token and that the claiming read deletes.
The sealed passphrase is never readable by the server at any point.

## 11. A vault key under the passphrase, not keys from the passphrase

Deriving the content keys straight from the passphrase made the passphrase
unchangeable in practice: rotating it changes the derived keys, which makes
every clip ever stored unreadable. "Change your passphrase" would have meant
"re-encrypt your entire history, from a device that holds all of it".

So the content keys now hang off a vault key, and the passphrase only wraps
that key. Rotation re-wraps 32 bytes. Nothing else moves, and other devices do
not even need to know it happened, because they hold the vault key rather than
the passphrase.

The same indirection improves linking: a device that joins by QR receives the
vault key alone, and never learns the passphrase. Previously linking handed
over the passphrase itself.

*Correction (audit, 2026-09):* this section originally went on to say such a
device "cannot derive the KEK, so it cannot change the passphrase". The first
half is true and the second does not follow. Anyone holding the vault key can
wrap it under a KEK of their own choosing, and `PUT /api/vault/key` accepts a
wrapped key from any enrolled device -- so a linked device can replace the
passphrase and lock the owner out of every passphrase unlock. Decision 19
fixes it: the server now requires proof of the current passphrase before
accepting a new wrapped key.

**Migrating without re-encrypting.** Existing accounts have clips encrypted
under keys derived from `PBKDF2(passphrase, salt)`. Making *that value* the
vault key reproduces the old content keys exactly, so migration re-wraps 32
bytes and leaves every stored clip readable. There is a test asserting exactly
this, because it is the property the whole migration rests on. Agent configs
that still hold a passphrase upgrade themselves in place on first use, so an
agent already running as a service keeps working across the change.

**What migration does not fix.** For a migrated account the vault key is still
a function of the original passphrase, so someone who knows that passphrase can
recompute it even after a rotation. Rotation locks out the web UI and any
`CLIPSYNC_PASSPHRASE` device, but it does not retire the old secret. Doing that
properly needs a re-key: a fresh random vault key and a re-encryption pass over
history. That is worth building when a passphrase actually leaks; it is not
worth pre-emptively forcing every existing account through it. Accounts created
after this change start with a random vault key and do not have the problem.

## 12. Scan-to-join points the QR the other way

`clipsync link` has the joining device display a QR and the set-up device read
it. That works between two laptops and is useless for a phone, which is the
device most worth enrolling by camera — because it is the set-up machine that
would need to do the scanning, and desktops rarely can.

So invites reverse it: the set-up device displays, the phone scans. That single
change also removes most of the cryptography. When the QR travels to the
scanner directly, it can carry a secret rather than merely a public key, so
there is no key agreement to perform and no fingerprint for a human to compare:

    S = 32 random bytes, generated on the set-up device
    server holds  AES-GCM(HKDF(S), vaultKey)  and  SHA-256(S)
    phone reads S from the camera and opens the payload

The server never sees S. It holds a ciphertext it cannot open and a hash that
tells it nothing, and it still cannot substitute anything, because it was never
on the path S travelled.

`SHA-256(S)` exists so that knowing an invite id is not enough to claim it.
Without that check, guessing or observing an id would mint a device token —
useless for reading clips, but enough to enrol and to push. S has 256 bits of
entropy, so the hash is not brute-forcible, and it is derived differently from
the sealing key.

**What this costs.** For its lifetime the code on screen *is* the credential;
anyone who photographs it can enrol. That is inherent to putting a secret in a
QR, and the mitigation is the obvious one: five minutes, one scan. The ECDH
flow in `link.ts` does not have this property, which is why both exist rather
than one replacing the other.

**What it does not solve.** A phone still cannot capture what you copy on it.
No browser can read the clipboard in the background on iOS or Android, so the
phone receives and pastes but does not push. Fixing that needs a share target
in a PWA on Android, or a Shortcut posting to the API on iOS.

## 13. Sharing, not capturing, on mobile

The desktop agent watches the clipboard. A phone cannot: no browser may read
the clipboard in the background on iOS or Android, and that is an OS decision,
not a gap to code around. Anything claiming otherwise on the web is either a
native app or is asking the user to paste.

So mobile capture is an explicit share. On Android that is a real share target,
declared in the manifest, which is why the app now ships a manifest, icons and
a service worker — installability is the precondition for appearing in the
share sheet, and a registered worker with a fetch handler is the precondition
for installability. The worker caches nothing deliberately: the payloads are
ciphertext fetched with a bearer token, and a cache would outlive the tab that
holds the key.

iOS has no share-target support, so a Shortcut opens `/share#text=…` instead.
The Shortcut carries only the text — it cannot encrypt, because Shortcuts has
no AES-GCM — and the web app does the sealing before anything is uploaded. The
two platforms therefore converge on one endpoint rather than growing separate
paths.

**The URL is the one place the text is plaintext.** Android's share target
put it in a query string (a POST form since §35), and a query string is sent to the server
with the page request, so every shared clip used to cross the edge
unencrypted, in a URL that proxies and request logs record. The service
worker now answers `/share` navigations itself, with the app shell fetched
without the query, so the text stays on the phone. The iOS Shortcut uses a
fragment instead, which browsers never send, so it does not depend on the
service worker. Either way the page scrubs the text from the address bar
once it has read it.

**The cost is the unlock.** Sharing opens a fresh tab, and the vault key lives
in sessionStorage, so every share would demand the passphrase. That is enough
friction that nobody would use it. The fix is an opt-in to localStorage,
default on for phones, stated plainly on the join screen: anyone who can unlock
the phone can then read the clipboard history. It is the same bargain as any
notes app, but it is a bargain and it should be visible rather than assumed.

## 14. Tauri for the tray app

Electron was the obvious choice and the wrong one. A tray app runs all the
time, so its idle cost is the cost: roughly 150 MB on disk for Electron against
5 MB for Tauri, which links against the system webview instead of shipping one.

The memory saving is real but smaller than the binary size implies -- measured
here at about 135 MB resident with the panel loaded, because WebKit dominates
either way. Disk, startup and update size are where Tauri actually wins.

The usual reason to take Electron anyway is that Tauri needs GTK and WebKit
development headers that may not be installed and may need root. Checking
first showed the machine already had all of them, so the objection did not
apply.

The Rust side stays deliberately small — a tray icon, a panel that shows and
hides, and one command that reads the agent's config file. Everything else is
the same TypeScript the CLI and the web UI run, including the crypto, so the
tray app adds a window rather than a second implementation to keep in step.

Reading the agent's config is what makes it need no enrolment: the credentials
and vault key already sit in `~/.config/clipsync/config.json`, so the panel
inherits them. The hooks it shares with the web UI moved to `packages/react`
for the same reason the crypto is shared — reconnection and event handling are
easy to get subtly wrong twice.

**A trap worth recording.** Building the crate with `cargo build --release`
produces a binary that still points at the Vite dev server and fails with
`connection refused`. Embedding the compiled frontend is the Tauri CLI's job,
not the crate's, so the build has to go through `tauri build`. The failure is
confusing because the binary is produced successfully and only misbehaves at
runtime, on a machine where the dev server happens not to be running.

## 15. A paste box beside the share sheet

Sharing covers most of what a phone needs to send, but not all of it: a 2FA
code, a password-manager field, text copied from an app with no Share action.
None of those can be shared, only copied.

So the web UI also takes a paste. It is strictly more taps than sharing -- copy,
switch app, tap, paste, send, against select and Share -- so it is the fallback
rather than the headline. Having both means there is no category of text the
phone simply cannot send.

It is a plain textarea, not a "paste from clipboard" button, and that
distinction is the whole design. `navigator.clipboard.readText()` is a
programmatic read: iOS shows its paste-permission banner on every call and
Chrome requires a permission grant. A manual paste into a field asks nothing,
because the user performing the paste is the consent. The convenient-looking
button is the worse experience.

## 16. The desktop app pays for the "no CORS surface" decision

Serving the web UI from the Worker's own origin meant the API never needed CORS
headers, and not having them is a genuinely smaller attack surface. The tray app
then broke on exactly that: its webview runs at `tauri://localhost`, so every
call is cross-origin, and WebKit reports the resulting block as `TypeError: Load
failed` -- a message that says nothing about the cause.

Two ways out. Adding `Access-Control-Allow-Origin` for the Tauri origin is three
lines, and permanently widens a personal API to suit one client. Routing the
desktop app's requests through Rust with the Tauri HTTP plugin leaves the server
exactly as strict as it was, scoped by capability to the Worker's URL and
nothing else. The second is better: the client adapts to the server, not the
reverse.

WebSockets were never affected -- they are not subject to CORS -- so the live
socket kept working throughout and only the HTTP calls failed, which made the
failure look stranger than it was.

**Two Tauri traps worth recording.** Tauri v2 denies core and plugin commands
from JavaScript unless a `capabilities/` file grants them, and the denial is
silent enough that a window that will not close looks like a UI bug rather than
a missing permission. And building the crate with `cargo` rather than the Tauri
CLI produces a binary still pointing at the dev server. Both fail at runtime,
neither fails the build, and both cost an hour if you debug them by reading the
code instead of by logging.

## 17. Dedupe across the whole history, not just the newest clip

The original rule was that a clip matching the *newest* one is a repeat and
anything else is a new event. That absorbed the duplicate events clipboard
managers emit, which was the problem it was written for, and it was wrong about
everything else.

Two consequences showed up together in real use. Copying something from last
week added a second identical row, so history filled with duplicates. And
`clipsync copy` writes to the clipboard, which the daemon then uploads -- so
deleting a secret and copying it again put it straight back, which is a poor
property for the one feature whose entire job is holding credentials briefly.

Matching `content_hash` across the user's whole history fixes both: a repeat
moves the existing row to the top instead of inserting. That is also what every
clipboard manager does, so it is what people expect.

The bump is a real event (`clip.bumped`) rather than a silent update, because
re-copying an old clip still means "put this on my other devices' clipboards".
Receivers treat it exactly like a new clip; the UI moves the entry instead of
adding one. When the match is already the newest clip there is nothing to
reorder, so that case stays a silent no-op -- which is the case clipboard
managers hammer.

The stored envelope is kept rather than replaced. It already decrypts to the
same plaintext, and a fresh nonce would buy nothing.

**The tests encoded the old behaviour.** Six checks failed on the first run
after this change, all of them assuming a fixture would be *created* rather
than bumped, or that a clip stays where it was in the list. They also made the
suite single-use: running it twice against one database now fails on the second
pass. Fixtures are tagged per run and lookups go by id rather than position, and
the passphrase-rotation test now rotates back, so the suite is re-runnable --
which is what caught this in the first place.

## 18. The tray panel is its own device

The panel first reused the agent's device outright -- same token, same device
id -- because that made it need no enrolment. It also made it deaf to this
machine. The Worker fans every event out to all devices except its origin
(decision 7), so each clip the agent pushed was, correctly, withheld from the
panel sharing its identity. Local copies appeared only after a restart.

Refetching whenever the panel opened hid the problem without fixing it: a clip
copied while the panel was already open still did not appear.

The panel now enrols itself on first run. The agent mints a pairing code with
its own token and the panel redeems it immediately, becoming `<name> (tray)`;
the vault key still comes from the agent's config, so there is no passphrase to
type. Echo suppression then works for the panel instead of against it: a clip
it copies is pushed by the agent, which is a different device, so the panel
receives it like any other.

Two alternatives were worse. Letting a device opt into its own echoes would
weaken the guard decision 7 relies on, for every client, to suit one. Having the
agent relay local copies to the panel over IPC would be a second sync path to
keep correct alongside the real one.

**Revocation is left alone.** If the tray device is revoked, the panel says so
and stops; it does not enrol again, although the agent's token would let it. An
automatic re-enrol would make revoking it meaningless. Deleting `tray.json` is
the deliberate way back.

## 19. The passphrase needs proof to change

Decision 11 said a device joined by link or invite "cannot change the
passphrase". It could. The wrapped key is the vault key sealed under a KEK
from the passphrase; a device holding the vault key can seal it under a KEK
from a passphrase of its own choosing, and `PUT /api/vault/key` took a new
wrapped key from any enrolled device. A phone added by QR could lock the owner
out of the web UI and every `CLIPSYNC_PASSPHRASE` agent.

The server cannot check the new wrapping -- it cannot open it -- so the check
has to be on who asks. The passphrase now yields a third HKDF branch beside
the KEK, a proof, and the server keeps SHA-256 of it. The first wrap sets it;
every later wrap must present the current proof, in one conditional `UPDATE`,
so a wrong proof and a lost race both write nothing.

**Why storing the hash costs nothing.** The server already holds the wrapped
key, which tests a passphrase guess offline at exactly the PBKDF2 cost the
hash would. The proof itself reaches the server only during a rotation, and as
an HKDF branch independent of the KEK it unwraps nothing. It is also derived
separately from the legacy vault key, which is the PBKDF2 master itself, so
sending it gives nothing away for migrated accounts either.

**Existing accounts** have a wrapped key and no proof. The server cannot tell
the owner's first proof from anyone else's, so the first one registered wins,
and clients register on every passphrase unlock to close that window as early
as possible. A registration that finds a different proof already there is
reported rather than hidden: it is exactly what a device that got there first
would look like. Re-keying (a fresh vault key sealed to each device) is what
fully removes a device; this only stops one from taking over.

## 20. A strict CSP on the web UI

The web UI can keep the vault key in `localStorage` (decision 13), which makes
script injection the one bug that turns into reading someone's clipboard. A
Content-Security-Policy is the cheap defence, and it only helps if it is
strict: a policy with `'unsafe-inline'` stops almost nothing that matters.

The build already allowed the strict form -- Vite emits no inline script or
style, and no component sets a `style` attribute -- so the policy allows this
origin and nothing else, served from `apps/web/public/_headers` by Workers
static assets. `frame-ancestors 'none'` and `X-Frame-Options` stop the unlock
screen being framed for clickjacking, and `no-referrer` keeps paths out of
anything the page links to.

Walking every screen under the policy in a real browser, rather than trusting
the build, also found a bug that had nothing to do with it: approving a device
link from the web UI had never worked, because the shared link helpers built
URLs with `new URL(path, "")`, which throws for the same-origin base the web
UI uses.

## 21. Limits keyed by address, skipped without one

Four endpoints must work without a token: bootstrap, pair-code redemption,
invite claims and link requests. Each had some protection of its own (a secret,
single use, a short expiry) but nothing stopped repetition, and the link
endpoint's only flood guard -- a global cap of 20 pending requests -- let
anyone block `clipsync link` for everyone with 20 anonymous POSTs.

They are now rate-limited through Workers rate-limiting bindings, keyed by
`CF-Connecting-IP` plus the endpoint, so spending one endpoint's budget does
not spend another's. Bootstrap, which guards the admin secret, gets 5 a
minute; the others 10. Pending link requests are capped per address (3), with
a global ceiling only to bound the table.

**Why missing addresses are not limited.** Cloudflare sets that header on
every request that reaches the Worker, and a client cannot override it; it is
absent only in local development. Keying missing addresses together would
throttle the e2e suite and any repeated manual run for no protection, since
nothing in production arrives without one.

Correction, found later: under `wrangler dev` the header is not absent.
Local workerd fills it in from the connection, as `127.0.0.1`, so two e2e
runs within a minute tripped the bootstrap limit. Loopback addresses are now
treated as missing. The edge sets the header from the real client address,
which is never loopback for a request from the internet, so no real client
is exempted.

Invite proofs are also hashed once more at rest. The claimant presents
`SHA-256(S)`, and the table used to store exactly that, so anyone who could
read it during an invite's five minutes could claim a device token.

## 22. Re-keying: epochs, device keys, and re-encryption in place

Revoking a device stops its token, but it keeps the vault key, and the vault
key opens every clip. A re-key replaces the vault key; the questions were how
the new key reaches the devices that should keep it, and what happens to
history.

**Epochs.** The account has a `key_epoch`, and every clip records the epoch
it was written under. Devices hold a ring -- every key they have been given,
by epoch -- decrypt each clip with the key it names, and write only under the
current one. Writes name their epoch and the server refuses an old one with
409 `stale_epoch`: without that, a device that missed a re-key would keep
writing clips the revoked device can read.

**Device keys, not the passphrase.** Devices joined by link or invite never
learn the passphrase (§11), so a new passphrase-wrapped key is no use to them.
Each device registers a P-256 public key; the re-keying device seals the new
key to every active device's key (`d1.`, ECDH to an ephemeral key, device id
and epoch bound into the HKDF info so the server cannot swap copies between
devices or epochs). Revoked devices are not offered one. The alternative --
re-enrolling every device by QR after each revoke -- is the kind of chore that
means nobody revokes anything.

**One batch for the switch.** The epoch bump (guarded on `from_epoch` and the
passphrase proof), the new wrapped key and the sealed copies land in one D1
batch. A device can never see the new epoch without its copy, and two racing
re-keys cannot both win.

**History re-encrypted in place, by clients.** The server cannot re-encrypt;
it holds no key. The re-keying device pages through clips under older epochs
(`?epochBelow=`) and writes each back re-encrypted, each write conditional on
the clip still being at the epoch it was read at, so passes are resumable
(`clipsync rekey --finish`) and safe against a second device doing the same.
The dedupe tag is rewritten too, since it is keyed per epoch. The alternative,
keeping old clips under old keys forever, would leave the revoked device able
to read all of history from any copy of the database -- the thing a re-key is
for.

**The browser's key is non-extractable.** It lives in IndexedDB as a
`CryptoKey` the page can use but not export, so script injection could ask it
to open a sealed copy but cannot walk off with the key itself. The agent and
tray keep theirs in their 0600 config files, next to the vault keys they
already hold.

**Traps.**
- A passphrase change reads the wrapped key, re-wraps it and writes it back.
  A re-key in between keeps the same proof, so the write succeeded and put the
  old key back behind the passphrase. `PUT /api/vault/key` now takes the epoch
  it re-wrapped and lands only if the vault is still there.
- A device that lost its keypair (cleared IndexedDB, rewritten config)
  registers a new one, and the copy sealed to the old one fails to open. That
  is the same as having no copy: the client reports it as stranded.
- Dedupe hashes are per epoch, so the agent's echo guard must be re-primed
  under the new key when it switches, or it pushes the clipboard back as new.
- A device that never registered a key (one that has not run since device
  keys existed) is left out of a re-key and told so; the agent then exits 78
  like a revoked one, and a browser falls back to the passphrase.

## 23. Catching up, and leaving no device behind

**Catch-up applies one clip, and only after a reconnect.** The server queues
nothing for a socket that is down, so a laptop that slept through a copy on
the phone missed it. After a reconnect the agent looks at the newest clip and
applies it if it came from another device, is under ten minutes old, is newer
than the last change it saw on the local clipboard, and is not already there.
Replaying every missed clip would flick the clipboard through them for no
benefit: history holds the rest. Not on first start, because a restart (a
rebuild, a login) must not replace what was copied while the agent was down.
The web UI simply reloads the list on reconnect and when the tab is shown
again; it has no clipboard to overwrite.

Trap: "newer than the last local change" compares the server's `created_at`
with this machine's clock. A skew of a few seconds only matters for a copy
made in those seconds, and ten minutes bounds the damage.

**Revoke on failure rather than check first.** `login` and `pair` used to
enrol and then find the passphrase wrong, leaving a device nobody held. The
alternative -- check the passphrase before enrolling -- needs the salt and
wrapped key before any credential exists, which is an unauthenticated
endpoint that hands anyone the material to guess the passphrase offline.
Instead a device that cannot unlock revokes itself (`DELETE
/api/devices/me`). The pair code is spent either way; that was true before.

`logout` and "Unpair" revoke first for the same reason: a token forgotten
only locally left the device listed forever and sealed to by every re-key.
An approved link nobody collected is revoked when its row expires, in the
same batch that deletes the only copy of its token.

**Paging on `(created_at, id)`.** The cursor was `created_at` alone, so a
page boundary inside one millisecond skipped the rest of that millisecond.
Re-encryption and bumps make shared timestamps common. The cursor is now
`<createdAt>.<id>`; a bare timestamp from an older client still parses, with
the old behaviour.

Trap found on the way: the agent's clipboard write waited for the tool's
stdio to `close`. `xclip -i` and `wl-copy` fork a child that holds the
selection and those pipes until the next copy, so every write stayed pending
until then. Writes now settle on `exit`.

## 24. Envelope v2: an authenticated header, not a server-side check

v1 envelopes are bare AES-GCM under the vault key. Every one of the user's
ciphertexts opens equally well in any row, so the server could put last
week's clip in a new row, name another device as its source, and push it as
a fresh copy: the agent would dutifully write it to the clipboard (audit O8).

**What is bound.** v2 is `v2.<header>.<iv>.<ct>`. The header is base64url
JSON naming the copying device, its clock at the copy, and the clip type.
The associated data is `clipsync:clip:v2:<account>:<header as encoded>`, so
the header cannot be edited, a ciphertext cannot be spliced under another
header, and an envelope cannot move to another account. The header is not
secret: the server already knows the device, roughly the time, and the type.

**What clients check.** After opening a v2 clip, a device requires the
header's device and type to match the row, and the row's dedupe tag to be
the HMAC of the plaintext. The agent refuses a clip whose authenticated copy
time is more than ten minutes old (the catch-up window, which also absorbs
clock skew). The server can still withhold, delay within ten minutes,
reorder, or replay a clip into its *own* row, where it shows its true age.
None of that puts foreign content on a clipboard.

**Alternatives.** A client-chosen clip id in the associated data was the
roadmap's first idea. It protects the id, but ids mean nothing to a user: the
device and the time are what the agent acts on. Server-side signing adds
nothing, since the server is the party being guarded against.

**Bumps replace the envelope.** A re-copy used to keep the first copy's
envelope. Under v2 that envelope names the first copy's device and time,
which would contradict the row the bump rewrites, and would read as a
replay. The new copy's envelope now replaces it.

**v1 is readable, not trusted.** Old clips, and clients not yet updated,
still produce v1, so a server can replay a v1 clip. Re-encryption writes
v2, so `clipsync rekey` upgrades history. For a v1 clip, re-encryption
vouches for the device and time the server reported, which is the price of
the upgrade.

Traps:
- The Worker reads the header without the key (`peekClipHeader`) and
  insists it names the writing device. Clients never trust the header
  without opening the envelope.
- The dedupe check applies to v2 only. Old rows may carry tags from before
  the HMAC existed, and v1 has nothing else authenticated anyway.

## 25. macOS and Windows agents

**macOS shells out, like Linux.** `pbpaste` and `pbcopy` ship with every
Mac and cost what `xclip` does per poll. They transcode through the locale,
and launchd starts jobs with none, so the agent forces a UTF-8 locale when
the session has no UTF-8 one. Without it, anything beyond ASCII is mangled
only when running as a service, which is the worst time to find out.

**Windows keeps one PowerShell alive.** Starting PowerShell costs a few
hundred milliseconds of CPU, which is fine once but not every 600 ms poll.
A native addon would mean a build toolchain on every Windows machine. So one
helper process runs a small read-eval loop: `R` and `W <base64>` in,
`OK`/`ERR` lines out, text in base64 so the pipe is ASCII whatever the
console code page. Requests are queued one at a time. A helper that dies or
stops answering is killed and restarted on the next request, and its first
answer gets a longer timeout because PowerShell starts slowly.

Trap: Windows hands text back with CRLF whatever was put in. The helper
reads CRLF as LF. Otherwise a clip applied from Linux reads back as
different text, fails the echo guard and is pushed straight back.

**launchd cannot skip one exit status.** systemd restarts the agent on
failure except status 78 (revoked). launchd's `KeepAlive` has only
`SuccessfulExit`, so the plist sets `CLIPSYNC_SUPERVISOR=launchd`, and the
agent then exits 0 for "stop for good" and keeps 75 for "restart onto the
rebuilt bundle". The alternative, a wrapper script mapping statuses, is one
more moving part in the one place nobody looks.

**Not done.** A Windows installer: a logon task that runs node without a
console window has no clean answer, so the README gives an untested task
instead of shipping one. The tray panel stays Linux-only for now.

## 26. Images and files: a key per file, and a budget the Worker enforces

**A key per file, carried in the envelope.** Each file is encrypted under a
random key of its own, and that key sits in the clip's v2 envelope with the
name, type, size and SHA-256. Encrypting under the vault key directly would
mean a re-key downloads, re-encrypts and re-uploads every file: R2
operations, bandwidth and time for exactly the job that must be quick after
a revoke. With a per-file key, the re-key re-seals the small envelope, and a
revoked device that later obtains the bytes has no key for them unless it
kept the old envelope. It could equally have kept the file itself.

**Chunks, each bound to its place.** 1 MiB chunks, each AES-GCM sealed with
associated data naming the blob, its index and the chunk count, so the
server cannot reorder, splice or truncate a file. The downloader also checks
the whole file against the envelope's digest. The dedupe tag is an HMAC of
that digest, so re-sending the same file bumps the existing clip. The bump
moves the row to the new upload and deletes the old one, because the new
envelope holds the new blob's key.

**A budget, because R2 has no cap.** Past its free tier (10 GB-month, 1M
Class A and 10M Class B operations a month) R2 bills, and Cloudflare offers
no spending limit to set from here. Nothing but this Worker touches the
bucket (no public access), so the Worker counts every billed operation in
D1 before making it, and refuses past a budget set at half the free tier.
The counter is a conditional UPDATE, so racing requests cannot share the
last unit. Deletes are free and never refused.

**Storage makes room rather than filling up.** Storage is a ceiling on
bytes held, which keeps GB-months under it too. A new upload that would not
fit deletes the oldest unpinned files first, and is refused only when
pinned files alone fill the ceiling. Files also expire after 7 days rather
than 30, and uploads nothing adopted are swept after an hour. The
alternative, refusing at the ceiling, leaves a full bucket that blocks
every new file until someone deletes by hand.

Traps:
- Room is reserved when the blob is created, from the declared size, so
  concurrent uploads cannot overshoot the ceiling between chunks. The
  reservation's INSERT is conditional on the running total.
- R2 objects persist across Worker tests like D1 rows; the test setup
  clears the bucket before each test.
- The agent daemon does not apply file clips. Fetching them on every
  device would spend the download budget on bytes nobody asked to paste.
  Images are the exception, since §27.

## 27. Images through the clipboard

Copying a screenshot on one machine and pasting it on another is the point
of a clipboard sync, so PNG images now go through the agent like text. Other
files stay in history: a clipboard "file" is a list of paths, different on
every OS, and pasting one is not the same as having its bytes.

**Stored as files.** An image is uploaded exactly as `clipsync send` would:
its own key, chunks in R2, the free-tier budget. No second path to secure.

**Only when there is no text, and not every poll.** Reading an image means
fetching and hashing the whole picture. The agent looks for one only when
the clipboard holds no text, and only on every third poll (about 2 s), which
keeps the settle rule (two identical reads) at about 4 s for images. Images
over 5 MB, the size a device downloads unasked, stay in history. (As first
built, they were not uploaded at all; §28 fixes that.)

**The echo guard, keyed by digest.** Image tags are `img:<sha256>` in the
same `lastHandled`/`candidate` slots as text, so the guards need no second
set of rules. Digests are not keyed, so they survive a re-key.

Traps:
- xclip, owning the selection with an image, answers any target, including
  a text one, with the image's bytes. After applying an image, the poller's
  next text read got a PNG and pushed it back as text. The X11 backend now
  reads text only when `TARGETS` offers a text type.
- Windows hands an image back re-encoded, so its bytes differ from what was
  written. After writing an image, the agent re-reads it and guards that.

## 28. Copied files, and images in the form they were copied

The first cut of §27 missed the two most common ways people copy a picture.
In a file manager, a copied `photo.jpg` offers its path as text, so the
agent pushed `/home/…/photo.jpg` and the other devices got a string. In a
browser, "Copy image" offers `text/html` (and, in Firefox, the image's
address as plain text) beside the picture, and `wl-paste`, asked for no
type in particular, takes any `text/*`, so the markup won over the image.
Images over 5 MB were not uploaded at all, despite §27 saying they stay in
history.

**Ask for a type by name.** The Linux backends list what the owner offers
and request a plain-text flavour explicitly. An offer with no plain text is
not text, however many markup flavours it has.

**Look behind new text once, when it settles.** A file manager's text is
only the paths, and Firefox's is only the address. Asking for files (and,
for a lone URL, an image) on every poll would double the processes the
poller starts. Asking once per new copy costs nothing, so the text path
checks when content settles, before pushing it. Text that is not a lone URL
wins over an image: an office suite offers a picture of copied cells beside
their text, and the text is what was meant.

**Files as files.** Each copied file (up to 10, 25 MB each) is uploaded as
`clipsync send` would. Images among them are applied on the other side like
any copied image. Other files wait in history: putting a file on a
clipboard means writing it somewhere first, and a download nobody asked for
is not a paste. Windows Explorer offers no text for a file copy, so a
clipboard with no text is asked for files before images. The echo tag is a
digest of the paths, sizes and times, so the same copy is sent once. Finder
always offers text (the names), so macOS skips that check and its
`osascript` process.

**Images keep their type.** A JPEG is uploaded as a JPEG and written back
as `image/jpeg`, rather than converted. Converting needs an image library,
and a Linux or Windows paste takes JPEG as readily. Each backend says which
types it can write, and a clip in any other type stays in history.

Traps:
- `xclip -o` without `-t` asks for `UTF8_STRING`. An owner that offers only
  `text/plain` read as empty, so the backend now requests the flavour
  `TARGETS` named.
- Windows re-encodes a clipboard image to PNG on every read, which for a
  4K screenshot every two seconds is most of a core. The helper checks the
  clipboard's sequence number and answers "unchanged" instead.

## 29. Standalone binaries: Node single executables, built where they run

Running the agent took Node 22, npm and a checkout, which is a lot to ask of
a machine that only needs to watch a clipboard. The agent now also ships as
one executable per platform.

**Node SEA, not Bun.** `bun build --compile` cross-compiles every target
from one machine, which is tempting. But the agent is tested on Node, and
its riskiest code paths (WebCrypto's PBKDF2 at 600k iterations, ECDH, the
WebSocket client, `child_process` holding a PowerShell helper open) would
all run on a runtime nothing else exercises. A Node single executable is
the Node already tested, with the bundle inside. It costs about 120 MB per
binary (about 45 MB compressed), roughly what Bun's would.

**CommonJS inside.** On Node 22 a SEA's entry script must be CommonJS, so
`build-binary.mjs` bundles the CLI a second time in that format.
`import.meta.url` does not exist there, so the CLI finds its own file
through `node:sea`'s `isSea()`: the executable when it is one, the bundle
otherwise.

**Built on each platform's own runner.** The blob carries no snapshot or
code cache, so it is portable, and `--node`/`--target` can inject it into
another platform's `node`. CI builds each binary on its own OS and CPU
anyway, for two reasons. Each binary is run before it ships: a
cross-built one could only be inspected, never run. And an arm64 macOS
binary must be re-signed after the injection, which takes `codesign`, and
only macOS has it.

**Archives and one checksum file.** Each release holds a `.tar.gz` per Unix
target (to keep the executable bit), a `.zip` for Windows, and a
`SHA256SUMS` covering them all. An installer can fetch and verify from
the release alone.

**Unsigned, for now.** The macOS builds are signed ad hoc, which is what
Apple Silicon requires to run at all. They are not notarized: that needs a
paid developer account. Injection invalidates the Windows `node.exe`
signature, and nothing re-signs it. A checksum from the same release guards
against a corrupt download, not a compromised release. Signing is a
separate decision.

Traps:
- `postject` prints "Can't find string offset for section name '.note'"
  for Linux ELF binaries, and "The signature seems corrupted!" for Windows
  ones. Both are expected; the binaries run.
- Replacing a running binary with `cp` fails on Linux ("Text file busy").
  Install by writing a new file and renaming it over the old one. The
  running agent's `watchFile` sees the rename and exits 75 to be restarted
  onto it, as it does for a rebuilt bundle.
- A blob must be made by the same Node version as the binary it goes into.
  CI uses the runner's own `node` for both. A cross build needs `--node`
  from the matching release.

## 30. Deploying from CI on every merge

A merge to `main` used to change nothing live until someone ran
`npm run db:migrate` and `npm run deploy` by hand, from a machine logged in
to Cloudflare. It was easy to forget the migration, and nothing showed what
was live. CI now does both after the checks pass.

**Migrate, then deploy, in one job after the checks.** The deploy job needs
the typecheck/unit and e2e jobs, so nothing reaches production that CI has
not passed. Within it, migrations go first: the new Worker may read tables
they create. That order means the old Worker runs against the new schema
for the length of the deploy, so migrations must only add. Dropping or
renaming a column takes two merges: stop using it, then remove it.

**Queue, never cancel, on `main`.** The workflow used to cancel an
in-progress run when a newer push arrived. On `main` that could stop a run
between its migration and its deploy, and nothing would finish the job. Pull
requests still cancel; `main` runs queue.

**Secrets, scoped narrowly.** The token comes from the Edit Cloudflare
Workers template plus D1 Edit, limited to the one account and the one zone.
Deploying a Worker with R2 and D1 bindings needs no permission on the
bucket or database themselves; only migrations need D1. A missing secret
fails the deploy job loudly rather than skipping it, so a green run on
`main` always means the change is live.

**A health check last.** The job fetches `/api/health` from the real domain
after deploying. A deploy that uploaded but does not answer is a red run on
`main`, not a surprise later.

Trap: `wrangler d1 migrations apply` asks "continue?" before applying. In CI
it detects the non-interactive terminal and answers its fallback, yes. It
would do the same for a destructive migration, which is one more reason
migrations here only add.

## 31. One database trip for a copy, not four

A copy took a noticeable second or more to show up on the other devices,
and most of that was not the agent. D1 keeps one primary, in eastern North
America. The Worker runs at the edge near the person, so every query it
makes is a crossing to that region and back, one after another. Writing a
new clip made four such trips: the token, the key epoch, the dedupe lookup,
then the insert. A re-copy made five. At a couple of hundred milliseconds a
crossing, which is typical far from the US, that is about a second before
anyone is told.

**Reads and the write in one batch.** A D1 batch is one round trip and runs
as one transaction, in order. The epoch read, the dedupe lookup and the
newest-clip lookup go first, and the insert follows, guarded on the epoch
and on no clip already holding this content. So a new copy (the common
case) is written in the same trip that decided it should be, and a re-copy
needs one more, for the update. With the token lookup that is two trips for
a new copy and three for a re-copy, down from four and five.

**Not Smart Placement.** Running the Worker next to the database would make
every query cheap, but the person would then cross the ocean once per
request, as would the WebSocket upgrade to a Durable Object that lives near
them. Cutting the queries helps every path and moves nothing.

**Images settle on the next poll.** The agent looks for an image only
every third poll, and the settle rule wants two identical reads. Waiting
for the next third poll for the second read added 1.2 s to every
screenshot. Once an image or file copy has been seen, the next poll reads
it again.

**Measured, not guessed.** `clipsync status` prints how long the Worker
takes to answer from here, and the extra cost of each database query.
Whether a further change is worth it depends on that second number, which
depends on where the person is.

## 32. `clipsync install`: the service belongs to the CLI

With a standalone binary (§29) there is no checkout to run
`scripts/install-agent.sh` from, and Windows never had a service at all. The
service definitions moved into the CLI, and the script now calls
`clipsync install` for its part.

**One command per OS, same exit-code contract.** A systemd user unit on
Linux and a launchd agent on macOS, unchanged from the script. On Windows, a
Task Scheduler task at logon. Every one of them must restart on 75 (a new
build is on disk) and never on 78 (revoked, re-keyed out, not enrolled).

**A supervisor inside the agent, for Windows.** Task Scheduler's "restart
on failure" cannot tell one exit status from another. So the task runs `clipsync supervise`, which runs
`clipsync run` and applies systemd's rules itself. The alternatives were
worse: NSSM or WinSW would be one more download to trust, and a real
Windows service runs in session 0, which has no clipboard.

**Hidden, without VBScript.** A console program started by Task Scheduler
keeps a console window open for as long as it runs. The task runs the
supervisor through `conhost.exe --headless`, which gives it a console
nobody sees. The usual alternative, a `wscript` shim, depends on VBScript,
which Windows is removing.

**No orphans.** Ending the task ends conhost, which need not take its
descendants with it, so the supervisor records its pid for `uninstall` to
stop. The agent runs with its stdin piped from the supervisor and exits
when that pipe closes, so however the supervisor dies, nothing is left
syncing on its own.

**Install copies the binary to a fixed place.** A service pointing into a
Downloads folder breaks when that folder is cleaned out. `install` copies a
standalone binary to `~/.local/bin` (`%LOCALAPPDATA%\Programs\clipsync` on
Windows), by writing beside it and renaming, then points the service there.
From a checkout, the service runs node and the bundle where they are.

**Not enrolled is a permanent stop, until enrolment.** `clipsync run` with
no credentials used to exit 1, which every supervisor restarts every five
seconds, for ever. It now exits 78, like revocation. Installing before
enrolling is allowed, and `link`, `login` and `pair` restart an installed
service once they have written credentials.

Traps:
- `schtasks /XML` wants UTF-16. The task file is written as UTF-16LE with a
  BOM, and declares that encoding.
- In Git Bash on Windows (CI), `schtasks /Query` has its switches rewritten
  into paths unless `MSYS_NO_PATHCONV=1`. The agent's own calls do not go
  through a shell and are unaffected.
- A machine with systemd installed but no user session reachable (WSL
  without systemd, a container, an SSH login) would get a binary copied and
  a unit written before `systemctl` failed. `install` asks systemd first.

## 33. One-command installers, served by the Worker

Setting up a computer took five steps: download, check the checksum,
unpack, link, install. Now it is one command, for each kind of shell:

    curl -fsSL https://clip.rfh.et/install.sh | sh
    irm https://clip.rfh.et/install.ps1 | iex

**Served by the Worker, filled in.** The scripts live in `scripts/` as real
files, which can be syntax-checked, and the Worker bundles them as text. It
serves each with its own origin in place of `__CLIPSYNC_URL__`, so a device
installed from a Worker links back to that Worker, whatever its domain. It
also fills in `RELEASES_REPO`, the repo whose GitHub releases hold the
binaries. Plain static assets could not do the first. Explicit paths, not a
`/` that sniffs `User-Agent` for curl: `/` stays the web app, and a browser
that opens `/install.sh` sees the script it is about to run.

**Verify, enrol, then install.** Each script downloads the archive for this
OS and CPU and the release's `SHA256SUMS`, and refuses a mismatch. A
checksum served beside the binary guards against a corrupt or truncated
download, not against a compromised release; signing is still open (§29).
If the device is not enrolled, it runs `clipsync link` from the downloaded
copy, so the QR is on screen in the same terminal. Only then
`clipsync install`, which copies the binary into place and starts the
service with credentials already there. Re-running upgrades: enrolled, so
no link, and `install` replaces the binary under the running service.

**A truncated script runs nothing.** `curl | sh` executes as it reads. The
shell script is one `main()` called on its last line, and the PowerShell one
is a single script block, so a connection cut mid-download leaves an
incomplete definition that never runs. The commands inside read nothing
from stdin (`link --url` asks no questions, and `</dev/null` makes sure),
so they cannot swallow the rest of a piped script.

**PATH.** The Windows installer adds its folder to the user PATH, since
nothing else will. The shell one only says how when `~/.local/bin` is
missing: most Linux desktops already include it, and editing someone's
shell profile unasked is worse than a line of advice.

**Settings from the environment.** `CLIPSYNC_VERSION` pins a release,
`CLIPSYNC_LINK=0` installs without enrolling (the service waits, §32), and
`CLIPSYNC_DOWNLOAD_BASE` fetches from a mirror. CI uses the last two to run
both installers on real macOS and Windows runners against the job's own
archive, served locally.

Trap: `wrangler dev` rewrites the request URL to the route's custom domain,
so a locally served installer names `http://clip.rfh.et`. Set `CLIPSYNC_URL`
when testing against a local Worker. In production the origin is the real
one.

## 34. Agents update themselves, from releases the server cannot choose

With the Worker deploying on every merge (§30), the agents were what lagged:
each machine ran whatever release it was installed with until someone
re-ran the installer. A supervised release binary now updates itself.

**The server does not choose the binary.** The obvious design has the
Worker say "the latest agent is v0.4.0, fetch it from here". But the
Worker is not trusted with anything readable: it sees only ciphertext.
One that could name the next binary would be trusted with every device, so
a compromised Worker, or anyone able to change its responses, could run
code on all of them. So the releases an agent looks at are baked in when
it is built (`__CLIPSYNC_RELEASES__`, the GitHub releases of the repo that
built it). The agent asks GitHub directly: `releases/latest` redirects to
the newest tag, which it reads without following, so there is no API call
to rate-limit. The planned `/api/version` endpoint was dropped for the
same reason: all it could safely say was the minimum below.

**Checked three ways before it replaces anything.** The download must match
the release's `SHA256SUMS`. It must run, and report itself as the release it
was fetched as (`--version`), so a truncated, corrupt or mislabelled binary
never replaces one that works. And the release must be newer: an agent never
moves backwards, so an old release cannot be served as "latest" to undo a
fix. The checksum comes from the same release as the binary, so it guards
against corruption, not a compromised GitHub account; signing (§29) is what
would. Releases publish each binary gzipped (`clipsync-<target>.gz`) beside
the archives, so the agent needs `zlib` and no archive reader.

**Swapped by rename, restarted by the supervisor.** The new binary is written
beside the old and renamed over it, then the agent exits 75, and systemd,
launchd or `clipsync supervise` starts the new file. Windows refuses to
rename over a running executable, but lets it be renamed aside first. The
aside gets a name of its own (`clipsync.exe.old-<time>`), because the
Windows supervisor keeps running from the old file and it cannot be deleted
yet. Leftovers are cleared at the next start. Only supervised agents update
on their own: one started by hand in a terminal would have nobody to
restart it.

**When:** a minute after start (spread over that minute, so machines
restarting together do not ask at once), then daily, and at once when the
server refuses a write as too old. Only release builds: a build from a
checkout names a commit, and git updates it. `CLIPSYNC_AUTO_UPDATE=off`
stops the automatic checks; `clipsync update` still works.

**A minimum the server enforces.** Every agent request carries
`x-clipsync-agent: <build>`. Past a change that older agents would
mishandle, `MIN_AGENT_VERSION` is raised, and the Worker refuses their
writes with 426 `agent_outdated`. That is the one thing a stale agent
could get wrong: a write in a form other devices no longer read. It can
still read, take its socket ticket, register its key and log out, so it
keeps receiving and hears that it must update, which it then does. The
header is only a claim, so this protects against honest old agents, not
against lying clients, which the envelope checks already handle. Browsers
send no header and are never gated: they load the web app from the Worker
itself, so they are always current. The tray sends none either; it is
built from a checkout, like the agent it sits beside.

Trap: an agent refused at a gate that covered every non-GET request could
not even take a socket ticket (a POST), so it went deaf as well as mute.
The gate lets through the few requests that write nothing another device
reads.

## 35. The phone as a device: shared files stay on it until they are sealed

A phone could send text (§13, §15) but not photos or files from the share
sheet. Sending what it had just copied took several taps, and copying what a
desktop had just sent took several more.

**The share sheet POSTs, and the service worker answers.** Files can only be
shared to a web app as a `POST` form (`share_target` with `enctype:
multipart/form-data`), and a form sent to the network would carry the
plaintext to the edge. So `public/sw.js` answers `POST /share` itself. It
reads the form, keeps title, text, url and files in IndexedDB, and redirects
to `/share?pending=<id>`. The database is `clipsync-shares`, separate from
the device-key database, so neither's schema version depends on the other.
The page seals and uploads each part, then deletes the kept copy. Text shares
take the same path, so they no longer appear in a URL at all. The GET handler
stays for installs whose manifest predates this, and the Shortcut's fragment
form is unchanged. A share nobody finishes sending (the phone left locked) is
dropped after a day. If storing fails, the worker still does not forward the
form: it sends the page to `/share?failed`, which says nothing was sent.

**The Worker never sees `/share`.** With no service worker in the way, the
assets layer answers a `POST /share` with a bare 405 and invokes no Worker
code. Routing `/share` through the Worker (`run_worker_first`) would give that
case a friendlier page. But the Worker would then also see every `GET
/share?text=…` from an install without the worker, and Workers Logs record
request URLs. The rare unhelpful 405 is the better failure.

**A paste dock, beside the paste box.** §15 chose a textarea over a "paste"
button, because a programmatic read asks for permission where a manual paste
asks nothing. That still holds, and the textarea stays. But on a phone the
common case is "I just copied something elsewhere, now send it", and the
textarea makes that five steps. So when the page comes into view on a
touch-first device (`pointer: coarse`), a bar offers "Paste to ClipSync". The
tap calls `navigator.clipboard.read()`, takes an image if there is one and
text otherwise, and sends it. iOS answers the read with its own Paste bubble,
and Chrome asks for the permission once. A refusal says so, and the textarea
is still there. Nothing is read without the tap. No browser allows it, and a
page that read the clipboard whenever it was looked at would send whatever
happened to be there.

**"Copy latest", one tap.** A phone has no agent to apply another device's
copy, and a page may write the clipboard only inside a tap. So on a
touch-first device, the newest clip from another device sits in a card above
the history, with a Copy button. Images are copied as images through
`ClipboardItem`. The bytes are passed as a promise, because iOS Safari refuses
a clipboard write made after an await, and a file clip has to be fetched and
decrypted first. Chrome accepts only PNG, so other formats are converted on a
canvas. The history's Copy button does the same for image clips.

**`/phone` explains the rest.** It covers installing the app on Android, the
paste dock and Attach on iOS, and how to build the Shortcut that opens
`/share#text=` from Back Tap or the Action Button. It gives no iCloud link,
because building the Shortcut is a one-time step and a published one would
name this deployment's host. `SHORTCUT_URL` in `PhoneSetup.tsx` takes a link
if one is ever shared. The Shortcut opens Safari, whose storage on iOS is
separate from the Home Screen app's, so Safari needs pairing too; the page
says so.

Trap: the Shortcut's fragment was parsed with `URLSearchParams`, which splits
at an unencoded `&` and turns `+` into a space. Everything after `#text=` is
now the text, decoded once.

## 36. Hearing about a copy instead of polling for it

The agent read the clipboard every 600 ms and pushed a change once two reads
agreed, so a copy took 0.6 to 1.2 s to leave the machine. Every read also
started a process (`xclip`, `wl-paste`, `pbpaste`) or a PowerShell cmdlet,
several times a second, all day. Each platform can say when its clipboard
changes, so the agent now listens and reads only then.

**One mechanism per platform, none of them native code.** The single binary
(§29) rules out addons, so each is something the agent can drive from Node:

- **X11:** XFixes announces every new owner of the CLIPBOARD selection, and a
  copy is exactly that. No tool the agent can count on exposes it (xclip and
  xsel do not; `clipnotify` is rarely installed), so `src/x11.ts` speaks the
  protocol itself: the connection handshake with the Xauthority cookie, one
  atom, one extension query, one subscription, then events. It is under 300
  lines and needs nothing but the display's socket.
- **Wayland:** `wl-paste --watch` runs a command for every new selection. The
  command drains what it is handed, so the copying app's write completes,
  and prints a line. GNOME's compositor lacks the data-control protocol this
  needs, so there the agent listens to XWayland's clipboard through XFixes
  instead: the compositor keeps it in step.
- **macOS:** there is no notification; `NSPasteboard.changeCount` is how
  every Mac clipboard tool notices a copy. A long-lived `osascript` in
  JavaScript for Automation asks ten times a second, one call to the
  pasteboard server each time, instead of the agent starting `pbpaste`.
- **Windows:** the PowerShell helper that already serves reads and writes
  registers a message-only window with `AddClipboardFormatListener` and
  pumps its messages on a thread of its own, printing `C` between replies.
  It is plain Win32 through P/Invoke rather than Windows Forms, so the same
  C# compiles in PowerShell 5.1 and 7.

**Quiet, then push.** A copy is often a burst of writes (plain text, then
rich; a clipboard manager taking ownership again). Polling handled that by
waiting for two reads to agree. With events, the agent waits for 100 ms
without one, reads once, and pushes at once. Between two agents on
Xvfb displays and a local Worker, a copy reached the other clipboard in a
median of 144 ms (worst of ten: 317 ms), against 1,088 ms when polling, and
each idle agent used a quarter of the CPU (8 clock ticks in 15 s, against
35).

**Trusted, but checked.** An event source that misses copies would be worse
than polling, silently. So a poll remains every 5 s. If it finds content that
is neither what the agent last handled nor what the last event's read found,
with no event in the last 2 s, the events have missed a copy. The agent says
so, stops listening and polls every 600 ms from then on. A watcher that
cannot start at all (no XFixes, a compositor without data-control, no
desktop session) means polling from the start, as does `CLIPSYNC_WATCH=off`.
`clipsync watch` prints each event, to check a machine; the Release workflow
runs it against each platform's own clipboard tools on all five runners.

Trap: an event arrives for the agent's own writes too. Text is fine: the
read after it matches `lastHandled`. An image is not: Windows re-encodes it,
and the agent only learns the bytes it will read back by reading them. An
event read between the write and that read-back would have pushed the
re-encoded image as a new copy. Reads now wait while a remote clip is being
written and read back (`writing`), and an event that came meanwhile is read
afterwards.

## 37. Receiving files, when asked

Files sent from another device waited in history: `clipsync get` or the web
UI fetched them. A desktop can now take them as they come.

**Off unless asked for.** A copied image replaces a copied image, and that
is what a clipboard is. A file is a download: disk space, a name in a
folder, bytes someone else chose. So a device receives files only once its
owner says so, with `clipsync receive on`. The setting is kept in the config
file, not only an environment variable (`CLIPSYNC_RECEIVE_FILES` still
overrides it), because the agent usually runs as a service, which does not
see the shell's environment, and the command restarts that service to take
it up.

**Saved, then put on the clipboard as a file.** The file goes into
`~/Downloads/ClipSync`: on Linux, the desktop's own Downloads folder from
`user-dirs.dirs`, whose name is often translated. The clipboard then gets a
file reference, not the path as text: `text/uri-list` on Linux, a furl on
macOS, CF_HDROP on Windows. Pasting in a file manager pastes the file. On
Linux it is the one type offered, so a file manager that only reads GNOME's
older `x-special/gnome-copied-files` (Nautilus before GTK 4) gets nothing;
offering both would mean the agent owning the selection itself.

**The name is another device's say-so.** It comes from an authenticated
envelope, but any device holding the vault key can write one, and a
compromised device could name its file anything. So only the last path component is kept, with
control characters, characters Windows refuses, leading dots and Windows's
reserved names removed. A file is never overwritten: the same bytes received
again reuse the file already there, and anything else becomes `name (1).ext`,
created with O_EXCL, so a file that appears meanwhile is not replaced.

**Not sent back.** The file on the clipboard reads back as a copy of files
and would be pushed straight back. The agent records the file it put there
(`receivedTag`, by real path, size and time: macOS reads `/var` back as
`/private/var`) and skips it. On macOS the check covers the text path too,
because Finder's text for a file is its name.

`test/native-clipboard.test.ts` runs every backend against the real
clipboard, including putting a file there and reading it back, on the
Release workflow's Linux (Xvfb), macOS and Windows runners.

Trap: on macOS, a clipboard write can be lost when the process that made
it exits straight away. The write reaches the pasteboard server
asynchronously, and the pasteboard is left with no types at all, so
re-reading never finds the file. AppleScript's `set the clipboard to
(POSIX file …)` lost 18 of 80 writes on the Apple Silicon release runner
and 2 of 80 on Intel, which showed up as an intermittent native-test
failure. Neither NSPasteboard's `writeObjects` nor `setString:forType:`
helped on its own: the agent's test still failed 8 of 20 and 4 of 20 runs
on Apple Silicon. What fixed it is reading the value back before
exiting: the agent's JXA writer sets `public.file-url`, reads it, checks
it, and only then exits. 30 of 30 test runs passed on each Mac. Image
writes copy their bytes through AppleScript, and none of 160 was lost.

## 38. The same server on Node: the bindings are the seam

The Worker only ran on Cloudflare. To run it on a home server, a NAS or any
VPS (and to stage on one), `apps/server` serves the Worker's own Hono app on
Node.

**No new abstraction layer.** The routes already reach the platform only
through `c.env` and `c.executionCtx`: D1 (`prepare`/`bind`/`first`/`all`/
`run`/`batch`), R2 (`put`/`get`/`delete`), the SyncRoom namespace
(`getByName` and five methods), two rate limiters, the vars, and
`waitUntil`. So those bindings are the interfaces, and the Node server
supplies objects of the same shape: `node:sqlite` behind a D1-shaped API, a
directory of files for R2, an in-process room on `ws`, an in-memory fixed
window, `setInterval` for the cron. The only change to the Worker was moving
the app out of `index.ts` into `app.ts`, so Node can import it without the
Durable Object, which imports `cloudflare:workers`. The alternative,
interfaces of our own with two implementations each, would have meant
rewriting every route for no gain in what either runtime can do, and a
third thing to keep in step. What the bindings choice costs: the Node side
must reproduce D1's semantics exactly, not approximately. That is
`batch` as one transaction, `meta.changes` counted for RETURNING statements
too (conditional writes are the mutexes), booleans as 1/0, foreign keys on.
`apps/server/test/d1.test.ts` pins each one. The e2e suite runs against
both runtimes in CI, so a route that drifts on either fails there.

**Built from the Worker, not copied from it.** The build reads
`wrangler.jsonc` for the vars and rate limits, and bundles the migrations,
so the two cannot drift. Migrations are recorded in wrangler's own
`d1_migrations` table. Self-hosted storage is not billed per operation, so
the R2 operation budgets are unlimited there; the byte ceiling stays
(`--storage`).

**The socket upgrade is the one real difference.** A Durable Object accepts
a WebSocket inside `fetch` and returns 101. On Node the upgrade belongs to
the HTTP server's `upgrade` event, outside any Request and Response. So the
room's `fetch` checks the request the same way, parks the device's identity
under a random handle, and returns the handle in a header. The server
completes the upgrade only for a handle that came back on the sync route's
response, and strips that header from every other response. Clients cannot
mint one: the ticket check comes first, exactly as on Cloudflare.

**What Cloudflare did that the server now does.**
- It sets `CF-Connecting-IP` from the connection, and drops any copy a
  client sent: the rate limits key on it. Behind a reverse proxy
  (`--trust-proxy`), it takes the *last* `X-Forwarded-For` entry, the one the
  proxy added, never the first, which is whatever the client claimed.
- It applies `_headers` to the web UI (the CSP is the page's main defence).
- It caps request bodies (32 MB).
- It sends protocol-level pings to find dead sockets.
- It shims `crypto.subtle.timingSafeEqual`, a Workers extension the
  bootstrap route uses.

Trap: Node's HTTP server sends any request with an `Upgrade` header to the
`upgrade` event, even without `Connection: upgrade`. Only the upgrade path
keeps the header; the plain path drops it, so a plain request to the socket
route gets 426, never a handle.


## 39. Staging on a shared machine: one Caddy, a deploy key that can do one thing

The Node server (§38) needed a real host before anyone relies on it. An
Oracle Cloud Always Free instance serves as staging,
`staging.clip.rfh.et`. It already runs other apps, which shaped most of
what follows. `deploy/server/` holds the setup, deploy and backup scripts.

**A tarball and a symlink, not a container or a build on the server.** CI
builds `apps/server/dist` (the server and the web UI, nothing to install),
packs it, and `clipsync-deploy` unpacks it into
`/opt/clipsync/releases/<time>`, points `current` at it, restarts the unit
and waits for `/api/health`. If that doesn't answer within 30 s, it points
back at the previous release. Five are kept. Building on the server would
put npm, a checkout and every install script on the machine. A container
would add an image registry and a second way to run the server, unlike
the one every self-hoster gets. Node itself comes from nodejs.org, checked
against its `SHASUMS256.txt`, not from Ubuntu's archive, which trails it.

**The CI key can do one thing.** It logs in as `clipsync-deploy`, whose
only sudo rule is `/usr/local/sbin/clipsync-deploy`. A key with an admin
login would hand every other app on the machine to whoever reads the
repository's secrets. The deploy job gives the secrets only to the steps
that use them, not to the job, so `npm ci`'s install scripts never see the
key. Staging deploys beside the Worker's production deploy, not before it:
they are different targets, and neither should hold the other up.

**One Caddy per machine, a site file per app.** `/etc/caddy/Caddyfile`
only imports `/etc/caddy/sites/*.caddy`, and setup.sh owns
`sites/clipsync.caddy`, nothing else. The machine's existing app ran its
own Caddy in Docker, holding 80 and 443, with its config in that app's
repository. The alternatives:
- Adding ClipSync's site to that Caddy. That ties ClipSync's ingress to
  another repository's deploys, which reset the file.
- A Cloudflare tunnel. It needs no ports, but it keeps Cloudflare in the
  request path that staging exists to take it out of.
- A second proxy on other ports. Browsers and ACME need 80 and 443.

What one shared Caddy costs: the other app's site moves into a
server-owned `sites/` file, its own Caddy is disabled by a
`docker-compose.override.yml` (which that repository already ignores), and
its API is published on loopback. If that app ever changes how it is
proxied, its site file must follow by hand. setup.sh never takes 80 or 443
from another process: it installs Caddy, leaves it disabled so it can't
race that proxy at boot, and says what to move.

**Backups** are `VACUUM INTO` (SQLite's consistent copy of a live database)
plus an archive of the blobs, nightly, 14 days, with a hook to copy each
snapshot off the machine. Everything in them is ciphertext.

Traps:
- Caddy's apt repository went unusable when its signing key expired
  (EXPKEYSIG). With its source list installed, `apt-get update` failed for
  the whole machine. setup.sh installs Caddy's release binary, checked
  against the release's SHA-512 sums, and writes the unit and user the
  package used to provide.
- Oracle's Ubuntu images end the INPUT chain with a REJECT. An ACCEPT
  appended after it exists, so `iptables -C` passes, but it never matches.
  Ports Docker publishes skip INPUT, so a Docker proxy on the same machine
  works and hides the fault until a host process binds 80. setup.sh
  deletes and re-inserts its rules at the top.
- Caddy keeps certificates in memory across `reload`. Replacing its
  storage underneath leaves it serving what it holds, and the loss shows
  only at the next restart.
- A restore must delete `clipsync.db-wal` and `clipsync.db-shm` before
  copying the snapshot in, or SQLite replays the old log over it.

## 40. `clipsync serve`: the server inside the agent binary

Running the Node server (§38) meant a checkout, npm and a build, or a
tarball plus a Node install (§39). The standalone `clipsync` binary
(§29) already puts Node on all five platforms, signed where it must be,
released with checksums and updating itself. So the server travels in it
as one more command, `clipsync serve`. One download runs either end, and
a Raspberry Pi or a NAS needs nothing else.

**One binary, not a second one.** A separate `clipsync-server` binary
would double the release matrix, the checksums and the installers for
the same Node and the same code. Carrying the server costs the agent
about 600 KiB of its 990 KiB bundle: the server, the Worker's app, Hono,
`ws` and the web UI. The binary is about 126 MB, nearly all of it Node.
`src/serve.ts` in apps/server is the command line both entry points
share, so `node clipsync-server.mjs` and `clipsync serve` take the same
options and cannot drift.

**The web UI is part of the bundle, not a SEA asset.** Node's SEA
`assets` exist only inside the binary, so the plain bundle
(`dist/clipsync.mjs`, run by `node` from a checkout) would have no UI.
`apps/server/build-plugin.mjs` turns `apps/web/dist` into a module,
`clipsync:web-files`, which both of the agent's builds include.
`StaticAssets.fromFiles` serves it under the same rules as a directory:
the `_headers` CSP on every page, `_headers` itself never served, the
SPA fallback, and ETags, here from a content hash. `build-binary.mjs`
refuses to build without `apps/web/dist`, so a release can't quietly
ship a server with no UI.

**Every other command stays as it was.** The CLI reaches `serve`
through a dynamic import, which esbuild keeps lazy inside one bundle.
`serve` is also routed before the CLI's own argument parser, which
would refuse the server's options. Two things would still have leaked
into every command:
- `node:sqlite`. As an external import, esbuild's ESM output hoists it
  to the top of the file. Then every `clipsync status` would load SQLite
  and print Node's experimental warning, and on a Node without it, crash.
  `SqliteD1` takes it from `process.getBuiltinModule` when a database
  opens, and imports only its types.
- The warning. A unit file can pass `--disable-warning`; a SEA takes no
  Node flags. `serve` swaps Node's `warning` listener for one that drops
  only SQLite's ExperimentalWarning and prints every other one.

CI runs the whole e2e suite against the Linux binary's `clipsync serve`.
Each of the five release runners starts it, checks the web UI and its
CSP, and fails if SQLite's warning reaches the log.

Not yet:
- `clipsync install` sets up the agent's service only, not a server's.
- A server started by `clipsync serve` doesn't update itself.

Trap: never import `node:sqlite` statically anywhere the agent's bundle
can reach. The build succeeds, and the cost appears only when running
some unrelated command.

## 41. A container image, built from source, with no `RUN` where it runs

Docker is how most NAS boxes and home servers run software, so the
server ships as an image too, `ghcr.io/robavelii/clipsync`, for amd64 and
arm64.

**The bundle, not the release binary.** The image could wrap the
standalone binary (§40) in a minimal base. But that ties the image to
releases: a pull request couldn't build and test the image without first
building a binary inside Docker. Instead the `Dockerfile` builds
`apps/server/dist` from the checkout, the same bundle the e2e-node job
tests, and runs it with the base image's Node. CI runs the whole e2e
suite against a container of it on every push.

**`node:22-bookworm-slim`, not distroless.** A distroless Node base would
make the image smaller than this one's 327 MB, but it has no shell, so `docker exec clipsync cat /data/admin-secret`, how most
people will enrol their first device, becomes a Node one-liner, and so
does any debugging on a NAS. The slim image keeps a shell and coreutils,
and runs the server as `node` (uid 1000), not root.

**One build, then a runtime stage with no `RUN`.** The build stage runs
on the builder's own platform (`--platform=$BUILDPLATFORM`), since a
bundle of JavaScript is the same everywhere. The runtime stage only
copies: the bundle, and an empty `/data`, owned by `node` and 0700. Docker
copies that onto a new named volume. With nothing to execute there, buildx assembles the arm64 image
on an x64 runner without QEMU. A `RUN` in that stage would bring
emulation back, and with it a much slower build.

**Configured by the environment.** `CLIPSYNC_DATA=/data` and
`CLIPSYNC_LISTEN=0.0.0.0:8787` are the image's defaults. The health
check reads `CLIPSYNC_LISTEN` to find the port, so moving the port is
done there rather than with `--listen`.

**Published with releases only.** A `v*` tag publishes the image after
all five binaries have passed, tagged with the version and its
`major.minor`. Pushes to `main` don't publish, so the image and the
binaries always come from the same tested release.

Traps:
- `COPY --chmod=0700 <dir> /data` set the mode with one BuildKit and
  not with GitHub's runner's, leaving `/data` at 755. The directory is
  made 0700 in the build stage and copied as an entry of its parent
  (`COPY /out/ /`), whose mode every version keeps. CI checks the mode.
- A host directory bind-mounted at `/data` keeps its owner and mode, so
  it must be writable by uid 1000. Only a named volume takes the
  image's.
- The first push creates the GHCR package as private. Anyone pulling
  without logging in needs it made public in the package's settings,
  once.
- Docker's port mapping keeps a remote client's address, but a
  connection to the published port from the host itself arrives from
  the bridge's gateway. Rate limits then key on that one address. Behind
  a reverse proxy on the host, pass `--trust-proxy`, as on any host.

## 42. The binary carries Node 24; the bundle still runs on 22

The standalone binary (§29) is a copy of the Node that built it, so its
Node decides what it runs on. It moves to Node 24, the active LTS, ahead
of Node 22's end of support in April 2027. Releases update themselves
(§34), so the move had to happen while it could still be tested and
documented, not under pressure.

**Only the binary.** The bundle's minimum stays Node 22. CI's unit tests
and e2e-node run there, staging's `setup.sh` installs it, and the
container image is built on it. A checkout or a server can choose its own
Node; the binary can't. The CI job that builds a binary and both release
builds use 24, so what CI tests is what ships.

**What it costs.** Node 24 requires macOS 13.5, where Node 22 required 11.
Windows (10) and Linux (glibc 2.28) are unchanged. A Mac on macOS 11 to
13.4 can't run the new binaries. The updater (§34) already runs a
download with `--version` before it replaces anything, so such a Mac
keeps working on the last Node 22 release. It would also download every
new release daily and reject it. Now the failure is a
`ReleaseWontRunError` naming the tag, and the daemon skips that tag for
the rest of its run. Only a newer release, a restart or a manual
`clipsync update` tries again.

Trap: don't raise `MIN_AGENT_VERSION` (§34) past the last Node 22 release
while such Macs matter. Those agents can't update past it, so the Worker
would refuse their writes for good.


## 43. Every request names its account

The schema was keyed by account from the start: every table carries
`user_id`, and each account has its own SyncRoom. Only the lookups weren't.
`getUser()` returned the oldest account, and seven routes used it: `/me`,
the vault key routes, pairing, and the link and invite claims. With one
account that was the right answer. With two, a device would be told
another account's salt and wrapped key, a re-key would aim at the wrong
account, and a new device paired into its own account would get the
other's salt and could not unlock. Storage eviction was global too: to
make room, it deleted the oldest unpinned files on the server, whoever
owned them.

So nothing asks for "the" account any more. A route reads the account its
request names: the calling device's (`getUserById(device.userId)`), the
one a pair code or invite was minted for, or for a link claim, the
account the approving device enrolled the new device into
(`getUserOfDevice`). `firstUser` remains, used by `bootstrap` alone: the
admin secret still creates the first account and enrols into it, until
signup replaces it. Eviction only takes the uploader's own oldest unpinned
files. An upload that would need another account's files to fit is
refused with 429, rather than taking them.

This was done before a second account can exist, so the tests prove it.
`test/accounts.test.ts` makes a second account directly in the database
and checks four things:
- each account's devices see only its salt, key, clips and devices;
- a pairing code enrols into the account that minted it;
- neither account can delete, pin or revoke the other's clips or devices;
- an upload evicts only its own files.

Run against the code before this change, the first two and the last fail.

What it doesn't cover yet: the storage ceiling and the monthly R2 budget
are still shared. One account can fill them, and the others are then
refused rather than robbed. Per-account quotas are the next step (the
multi-account design doc, PR 2). The e2e suite can't create a second
account until signup exists (PR 3).

## 44. Plans: per-account limits, read with the device

With more than one account, the Worker's R2 budgets (§26) are shared. §43
stopped one account taking another's files; this stops one account filling
everything. Each account has a plan, and the plan sets limits of its own
inside the Worker's budgets, which stay the outer guard.

**Plans are rows, not code.** A `plans` table holds each plan's numbers:
devices, text and file retention, whether files other than images sync,
bytes held, and R2 operations a month. A NULL means no limit of the plan's
own. `users.plan` names the account's plan. Existing accounts default to
`unlimited`, which sets nothing, so the owner's deployment behaves as
before. `free` carries #24's proposal (3 devices, 7 days, text and images)
plus starting quotas of its own: 50 MB held, and 2,000 uploads and 20,000
downloads a month. Changing a number,
or an account's plan, is an UPDATE, not a deploy, which is also what
billing will do later. Limits in code would have been typed and reviewed,
but changing a price or a quota would have taken a release.

**Read with the device, checked where it applies.** `resolveToken` already
reads the device on every authenticated request, so it joins the
account's plan in the same query. A route reads `c.var.device.plan` and
never makes another trip (§31). Each limit is enforced where its resource
is spent, in the statement that spends it:
- **Devices:** `createDevice` inserts only while the account's count is
  under the plan's, in one conditional INSERT, so two enrolments at once
  can't both take the last place. It runs for pairing, invites, links and
  bootstrap alike.
- **Retention and files:** the clip routes set `expires_at` from the
  plan's days, and refuse a `file` clip when the plan doesn't sync files.
- **Bytes held:** `reserveBlob`'s conditional insert checks the Worker's
  ceiling and the account's quota together. Eviction already takes only the
  uploader's files (§43).
- **R2 operations:** `spend()` keeps `account_usage` beside `r2_usage`.

**Two counts that move together.** `spend()` checks both budgets with
the conditional UPDATE of the Worker's count, as before, and in the same
statement stamps that row with a marker unique to the call. The next
statement in the batch increments the account's count only where the
stamp is that marker. The batch is one transaction, so either both counts
move or neither does, in one round trip. Checking the account first would
have meant a second statement that could take the Worker's budget while
the first was refused, and a compensating decrement to undo it.

Traps:
- SQLite refuses `REFERENCES` on an added column with a non-NULL default,
  so `users.plan` has no foreign key. An account naming a missing plan is
  logged and gets no limits of its own.
- The test setup puts `free` back to its seeded numbers before each test,
  since tests change them; plans aren't cleared with the other tables.

## 45. Signup by mailed code or admin invite; sign-in by passphrase proof

Accounts beyond the first need a way in. The server never sees the
passphrase, and losing it loses the clips whatever the account login, so
the account's handle is just an email address, not a password of its own.
The email also serves billing and contact later.

**Signup: six digits by mail, or an invite.** With `SIGNUP=open`, the
server mails a code; the device sends it back with the address, and gets
an account on `SIGNUP_PLAN` and its first device. The device then creates
the vault exactly as bootstrap's first device does. A code rather than a
link: the CLI and the tray can't open a link, and six digits are typed in
seconds. A code is good for 15 minutes and five guesses (each guess is
counted before it's judged), and an address gets at most one mail a
minute. The answer is 202 whether or not a mail went out. An admin invite,
minted with `ADMIN_SECRET` and good once for a week, makes an account on
any server, mail or not. That is how a self-hosted server adds accounts
without a mail provider, and how the e2e suite makes its second account.

**Sign-in: the email, then the passphrase's proof.** A device with
another device at hand joins by pair code, link or invite, as before. One
with none fetches the account's salt by email, derives `authProof` as
unlocking does, and the server checks it against `auth_hash`, the same
check that guards a key change. No mailed code too: the passphrase is the
secret that matters, and PBKDF2's 600,000 iterations make each online
guess slow for the guesser. Ten failures lock the account's sign-in for
the hour, so a guesser gets ten tries an hour at one address. An emailed
step on top would mostly add a mail dependency to recovering a device.

**Nothing says whether an address has an account.** The signup mail
endpoint answers the same either way. The salt endpoint gives an unknown
address a stand-in salt, an HMAC of the address under `ADMIN_SECRET`, as
stable as a real one, and a sign-in to it fails like a wrong passphrase.
A signup for a taken address says so, but only once the code shows the
caller reads that address's mail.

**Mail as SMTP over a socket, injected by the entry.** OCI Email Delivery
(3,000 free a month on the tenancy staging runs on) takes SMTP with TLS on
465. A mail server on the instance itself was ruled out: outbound port 25
is blocked there. Its HTTPS API needs OCI request signing; SMTP needs
three commands and a login. `mail.ts` speaks SMTP over any pair of byte
streams. The Worker entry builds the mailer on `cloudflare:sockets`, the
Node server on `node:tls`, and each puts it on the env as `MAILER`, so
`app.ts` still imports no runtime (§38). The body goes as base64, so no
line can begin with a dot or overrun SMTP's limit. The only header taken
from a request is the address, which must pass `normaliseEmail` first.

Traps:
- Ten failures lock an account's device-less sign-in for an hour, and
  anyone who knows the address can cause that. It doesn't touch the
  account's devices, or joining by pair code, link or invite.
- `wrangler types` types `SIGNUP` as the literal in `wrangler.jsonc`
  ("off"), so the code compares it with `String(...)`. A plain `===
  "open"` doesn't typecheck.
- A test SMTP server whose close waits for unread output hangs a client
  that never reads the `QUIT` reply. The client now reads it, and ignores
  a server that hangs up first.
- `unlockVault` takes a missing wrapped key for a legacy account (§11)
  unless told the account is new. Signup has no key yet, so
  `signUp` (`packages/client/src/account.ts`) passes `true`. The CLI and
  the web UI both go through it, so neither can get that wrong.
