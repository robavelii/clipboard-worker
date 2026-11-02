---
title: Security model
description: What the encryption protects against, what it does not, and exactly what the server can learn.
---

# Security model

ClipSync is built so that whoever runs the server cannot read your clipboard.
This page says precisely what that covers.

## What is protected

Someone with your server's database, its file storage, or the account it runs
on sees ciphertext and HMAC tags. They cannot read your clips. They cannot
confirm a guess either ("was this clip `hunter2`?"), because a dedupe tag is an
HMAC under a key they don't hold, not a plain digest.

## Keys

The **vault key**, 32 random bytes, protects clips: HKDF derives an AES-GCM-256
key for content and an HMAC-SHA256 key for dedupe tags from it. The passphrase
only unlocks it: PBKDF2-SHA256 with 600,000 iterations over a per-account salt,
then HKDF to a key-encryption key that wraps the vault key. The server stores the
wrapped form and cannot open it.

A second HKDF output of the passphrase is a **proof**: the server keeps its
SHA-256 and accepts a new wrapped key only from someone who presents it. So a
device that holds the vault key but never knew the passphrase, a phone that
joined by QR, can read but cannot change the passphrase and lock you out.

## Authenticated envelopes

Each clip's ciphertext is bound to your account and to a small header: which
device copied it, when, and what kind of clip it is. The server can read the
header, since it knows those things anyway, but cannot change it or move a
ciphertext into another clip's place. Devices refuse a clip whose header, row
or dedupe tag disagree.

The agent also refuses to apply a clip whose authenticated copy time is more
than ten minutes old, so the server cannot replay an old clip onto your
clipboard as a new copy.

## Images and files

Each file has a random key of its own and is encrypted in 1 MiB chunks. Each
chunk is bound to its file, its position and the chunk count, so the server
cannot reorder, splice or truncate a file. The key, name, type, size and SHA-256
live in the clip's envelope, and the downloading device checks the whole file
against that digest. A re-key re-seals only the envelope; the stored chunks are
never rewritten.

## Joining devices

**By QR (invite).** The vault key is sealed under a 256-bit secret that exists
only in the QR and reaches the phone through its camera. The server stores the
ciphertext and a hash of a proof derived from the secret: enough to check who
may claim the invite, not enough to open it. Invites last five minutes and work
once.

**By link.** ECDH over P-256 between the joining device's throwaway key and the
approving device, with both public keys bound into the key derivation, so a
swapped transcript derives a different key and fails closed. The server sees
two public keys and a ciphertext. The one attack left is a server that swaps in
its own public key, and that is what the six-digit fingerprint on both screens
catches. Link requests expire in ten minutes; collecting the result works once.

Both secrets travel in the URL's fragment (after `#`), which browsers never
send to a server.

## Tokens

Device tokens are 256-bit random strings, stored only as SHA-256 digests.
Pairing codes, invite proofs, link pickups and socket tickets are stored the
same way, and each single-use claim is one conditional write, so two claimants
can't both win. The WebSocket authenticates with a separate single-use ticket
valid for 30 seconds, because a long-lived token in a URL ends up in logs.

Revoking a device invalidates its token at once and closes its socket.

## Re-keying

Every device has a P-256 device key; the server has only the public half. A
re-key generates a fresh vault key, wraps it under the passphrase, and seals a
copy to each active device's public key and to the recovery key, binding the
device id and key epoch into the derivation, so the server cannot hand one
device another's copy or pass off an old key as new. Revoked devices get
nothing. The server refuses writes under a key the account has moved past.

## The recovery key

32 random bytes, shown once and never sent. It unwraps a private key that each
re-key seals the vault key to, like a device. Using it proves possession to the
server with another derived proof, and re-wraps the same vault key under a new
passphrase.

## Abuse limits

The endpoints anyone can call (first-account bootstrap, pairing, invite claims,
and link requests) are rate-limited per client address. Pending
link requests are capped per address, not globally, so no one can lock others
out of linking. Sign-in stops accepting attempts for an hour after ten wrong
ones, and never says whether an address has an account.

## The web app

The web app is served with a strict Content Security Policy (this origin only,
no inline script or style), refuses to be framed, and sends no referrer. A phone
can keep the vault key in browser storage, so script injection is the attack
that matters, and those headers are there to stop it. Links in clips open only
if they are `http` or `https`.

## What is not protected

- **The device itself.** The agent keeps the vault key and its device key in
  `~/.config/clipsync/config.json`, mode 0600, so it can start unattended.
  Anyone who can read that file can read your clipboard directly anyway, so this
  doesn't weaken what the encryption is for, but local compromise is game over.
  Set `CLIPSYNC_PASSPHRASE` in the service's environment instead if you'd rather
  keep keys out of the file.
- **Metadata.** The server learns what it can't avoid: how many clips you make,
  when, from which device, their type, and roughly how large they are.
- **A revoked device's old key.** Revoking cuts a device off but it keeps the
  key it had. [Re-key](passphrase-and-recovery.md#re-keying-after-a-revoke) after
  revoking a device you don't trust.
- **The admin secret.** Whoever holds it can make the first account, mint
  invites, and, together with one of your enrolled devices, reset your
  passphrase. It cannot read clips.
- **Weak passphrases.** PBKDF2 at 600,000 iterations slows guessing, but someone
  holding the database can still try guesses offline against the wrapped key.
- **Older clips.** Clips stored before authenticated envelopes carry no header
  until a re-key re-encrypts them.
