---
title: Adding devices
description: Four ways to join a device to your account, and when to use each.
---

# Adding devices

Every device of an account holds the same vault key. Adding one is a matter of
getting that key to it safely. There are four ways, and the first two never
ask anyone to type the passphrase.

| Way | Best for | What you do |
| --- | --- | --- |
| [Scan a QR](#scan-a-qr-phones-and-browsers) | phones, tablets, any browser | scan a code a device you already use shows |
| [Link](#link-another-computer) | another computer | the new computer shows a code, you approve it |
| [Sign in](#sign-in-with-email-and-passphrase) | no other device at hand | email and passphrase |
| [Pairing code](#pairing-codes) | screens that can't see each other | type a short code, then the passphrase |

## Scan a QR (phones and browsers)

In the web app, choose **Add device**. A QR code appears, valid for five
minutes. Point the phone's camera at it and open the link: the phone joins
straight away, and the web app says so when it has.

From a computer with the agent, the same code comes from:

```bash
clipsync invite
```

The QR carries a one-time secret in the part of the link after `#`, which a
browser never sends to a server. The vault key is sealed under that secret
before it reaches the server, so the server stores something it cannot open.
The code on screen *is* the credential, so it works once and only for five
minutes. Show it only to the device you mean to add.

**Adding a computer from the web app.** Under **Add device → Adding a
computer?** you get the install command, a box to paste a link from
`clipsync link`, and a pairing code.

## Link another computer

Here the QR goes the other way: the joining computer shows it.

```bash
clipsync link --url https://clip.rfh.et
```

The one-line installer runs this for you. It prints a QR, a link and a
six-digit code. On a device you already use, open the link (or scan the QR)
and check that the six digits match on both screens before you approve it.
From another computer with the agent:

```bash
clipsync approve 'https://clip.rfh.et/link#…'
```

Once approved, the new computer is enrolled and its agent starts.

> [!WARNING]
> If the six digits differ, do not approve. Matching digits prove the new
> computer's key reached you unchanged. A mismatch means something in between
> swapped it.

The new computer makes a throwaway key pair; the approving device seals the
vault key to it. The server relays ciphertext it cannot open. Link requests
expire after ten minutes.

## Sign in with email and passphrase

With no other device to hand, a device can join with the account's email
address and passphrase:

```bash
clipsync signin --url https://clip.rfh.et
```

In the web app this is **Sign in**. The server checks a proof derived from the
passphrase, never the passphrase itself, and stops accepting attempts for an
hour after ten wrong ones. An account needs an email address for this; see
[Your account](account.md#email-address).

## Pairing codes

The fallback for two machines that can't see each other's screens. On a
device you already use:

```bash
clipsync pair-code               # prints PAIR-XXXX-XXXX, valid 10 minutes, once
```

On the new device:

```bash
clipsync pair PAIR-XXXX-XXXX --url https://clip.rfh.et
```

This one asks for the passphrase. The CLI and the web app check it against
your existing clips straight away and say so if it is wrong.

## The first device on a new server

On a server you run yourself, the very first account comes from the server's
admin secret:

```bash
clipsync login --url https://clip.example.org
```

It asks for the admin secret, then a new passphrase. See
[Self-hosting](self-host.md#the-first-account).

## Listing, renaming and removing devices

```bash
clipsync devices                          # every device, with when each was last seen
clipsync devices --rename <id> "work laptop"
clipsync devices --revoke <id>            # cut it off now
clipsync devices --revoke <id> --rekey    # and move everyone else to a new key
```

In the web app: **Settings → Devices**. Revoking stops the device's token at
once and closes its connection. It still holds the vault key it was given,
though, so after revoking a lost or stolen device, [re-key](passphrase-and-recovery.md#re-keying-after-a-revoke).

To remove the device you are on: `clipsync logout`, or **Sign out of this
browser** in the web app's menu. Both revoke it on the server too, so no
device stays listed that nobody holds.

## Limits

Your plan sets how many devices an account may have: the free plan allows 3.
The tray panel counts as a device of its own. See [Plans and limits](limits.md).
