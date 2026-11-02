---
title: Passphrase, recovery and re-keying
description: Change the passphrase, get back in when you forget it, and lock out a lost device for good.
---

# Passphrase, recovery and re-keying

Your clips are encrypted under a **vault key**: 32 random bytes every device
holds. The passphrase only unlocks that key, and the server keeps it wrapped
under the passphrase. That one level of indirection is what makes everything on
this page cheap: changing the passphrase re-wraps 32 bytes, and no clip is
re-encrypted.

## Changing the passphrase

```bash
clipsync passphrase
```

In the web app: **Settings → Security → Change passphrase**. It asks for the
current passphrase first. Your other devices carry on without doing anything,
because they hold the vault key, not the passphrase.

The server accepts a new wrapped key only with proof of the current passphrase.
So a phone that joined by QR can read your clipboard, but it cannot change the
passphrase and lock you out.

## The recovery key

Signing up shows a recovery key once:

```
CSR1-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX
```

It is stored nowhere, the server included. Keep it like the passphrase: anyone
holding it can reset the passphrase.

```bash
clipsync recovery          # is there one, and does it still open the current key?
clipsync recovery new      # make one, or replace it (the old one stops working)
clipsync recovery off      # remove it
```

In the web app: **Settings → Security → Recovery key**. Each takes the
passphrase.

### Forgot the passphrase

With the recovery key, from any device, enrolled or not:

```bash
clipsync recover --url https://clip.rfh.et                   # asks for the email, the key, a new passphrase
clipsync recover --url https://clip.rfh.et --revoke-others   # and sign out every other device
```

or **Forgot the passphrase?** on the web app's sign-in screen. The vault key
doesn't change, so your clips stay readable and your other devices keep
working. The account's address is told it happened.

### Forgot it, and no recovery key

Whoever runs the server can reset it, from one of your enrolled devices:

```bash
clipsync passphrase --reset    # asks for the admin secret, then a new passphrase
```

The device wraps the vault key it already holds under the new passphrase, after
checking that the key opens the account's clips. It takes the server's admin
secret *and* a device of the account, so neither the operator nor a stolen
laptop can do it alone. On the hosted service, ask the operator. Afterwards, make
a recovery key so it never comes to this again.

With no recovery key and no device left, nothing can open the clips: not you,
not the operator.

## Re-keying after a revoke

```bash
clipsync devices --revoke <id> --rekey     # revoke, then re-key
clipsync rekey                             # re-key on its own
```

In the web app: **Settings → Devices → Revoke** offers **Re-key now**, and
**Settings → Security** has **Re-key**.

Revoking stops a device's token at once. But it still holds the vault key it was
given, and that key opens every clip it could get hold of, from a copy of the
database for example. A re-key moves the account to a new vault key and
re-encrypts history under it, so the old key opens nothing written since and
nothing already stored.

It needs the passphrase. Every other device keeps working with nothing to type:
each receives a copy of the new key sealed to its own device key, and picks it up
as soon as it hears of the re-key or next starts. The recovery key gets a copy
too, so it keeps working.

Re-encryption runs straight after the switch. If it is interrupted, resume it
from any device holding the old key. It is safe to run twice:

```bash
clipsync rekey --finish
```

A device that never registered a device key (one that has not run since device
keys were added) is listed at the end. It can still read old clips but not new
ones: enrol it again. A browser can simply unlock with the passphrase.

## Accounts from before the vault key

Accounts created before the random vault key existed use a key derived from the
original passphrase. Changing the passphrase does not retire that key, so
someone who knows the original passphrase could still recompute it.
`clipsync rekey` retires it. Accounts created since don't have the problem.
