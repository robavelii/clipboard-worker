---
title: Your account
description: Accounts, the email address, exporting everything, and deleting an account.
---

# Your account

A server holds any number of accounts. Each has its own vault, devices, clips
and plan, and none can see or reach another's.

## Making one

```bash
clipsync signup --url https://clip.rfh.et                       # a code is mailed to you
clipsync signup --url https://clip.example.org --invite SIGNUP-…  # with an invite
```

Or **Make an account** in the web app. It asks for the six-digit code from the
email (valid 15 minutes), then a new passphrase, then shows your
[recovery key](passphrase-and-recovery.md#the-recovery-key).

A server's operator decides who can sign up: anyone with an email address, or
only people holding an invite. See [Self-hosting](self-host.md#more-accounts).

## Email address

The address is how you [sign in](devices.md#sign-in-with-email-and-passphrase)
with no other device, receive notices (a passphrase reset, a changed address),
and confirm deleting the account. The first account on a server has none until
you give it one:

```bash
clipsync email you@example.org
```

or **Settings → Account → Email**. A code goes to the new address, and you
confirm with it and the passphrase. The same command changes it, and the old
address is told. Both are needed because the address alone can confirm a
deletion, so a device on its own must never be able to move it.

The server never says whether an address has an account: signing in with an
unknown address fails the same way a wrong passphrase does.

## Exporting everything

```bash
clipsync export ~/clipsync-export              # decrypted here
clipsync export ~/clipsync-export --ciphertext # the server's ciphertext, as it is
```

Every clip is decrypted on this device: text in `clips.json`, images and files
under `files/`. In the web app: **Settings → Account → Export**, which
downloads the same as JSON.

## Deleting the account

```bash
clipsync delete-account               # confirm with the passphrase
clipsync delete-account --by-email    # or a code mailed to the account
```

or **Settings → Account → Delete**. It deletes everything: clips, files,
devices and keys, then disconnects every device. It needs the passphrase or a
mailed code, so a stolen device can't do it alone. The server's backups keep a
deleted account until they age out.
