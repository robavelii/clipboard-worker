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
vault key alone. It can read and write clips but cannot derive the KEK, so it
cannot change the passphrase. Previously linking handed over the passphrase
itself, which gave every linked device full control of the account.

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
