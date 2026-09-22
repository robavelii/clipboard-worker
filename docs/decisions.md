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
