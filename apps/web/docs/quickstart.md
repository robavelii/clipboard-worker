---
title: Quick start
description: Make an account, sync your first computer, then add your phone. About five minutes.
---

# Quick start

These steps use the hosted server at `https://clip.rfh.et`. On your own
server, use its address instead; [Self-hosting](self-host.md) covers setting one up.

## 1. Make an account

Open [clip.rfh.et](https://clip.rfh.et) and choose **Make an account**. Enter
your email address and the six-digit code it receives, then pick a
passphrase.

> [!IMPORTANT]
> The passphrase is the only key to your history, and nothing on the server
> can recover it. Choose one you will remember: a few unrelated words work well.

Next you are shown a **recovery key** (`CSR1-…`). Write it down or keep it in
a password manager. If you ever forget the passphrase, it is the way back in.
[More on recovery](passphrase-and-recovery.md#the-recovery-key).

The browser you signed up in is now your first device.

## 2. Sync a computer

On the computer, run the installer for its system:

```bash
curl -fsSL https://clip.rfh.et/install.sh | sh        # Linux, macOS
```

```powershell
irm https://clip.rfh.et/install.ps1 | iex             # Windows, in PowerShell
```

It downloads the `clipsync` agent, checks it against the release's checksums,
and prints a QR code, a link and a six-digit code. In the web app you already
have open, open that link (or scan the QR), check the six digits match, and
choose **Approve**.

The agent then starts in the background and at every login. Copy something
on the computer: it shows up in the web app straight away.

On Linux the agent needs `wl-clipboard` (Wayland) or `xclip` (X11):

```bash
sudo apt install wl-clipboard xclip      # Debian, Ubuntu
```

## 3. Add your phone

In the web app on the computer, choose **Add device**. A QR code appears.
Point the phone's camera at it and open the link. The phone joins at once, with
nothing to type but a name for it.

On the phone, add ClipSync to the home screen (in the browser's share or
menu). On Android it then appears in the share sheet. See
[Web app and phone](web-and-phone.md) for the ways to send from a phone.

## 4. Check it works

```bash
clipsync status       # account, server, clipboard backend and service state
clipsync history      # your recent clips, decrypted here
```

## Next

- [Add more computers](devices.md), and see the other ways to join.
- Give the account a [recovery key](passphrase-and-recovery.md#the-recovery-key) if you skipped it.
- Learn the [keyboard shortcuts](web-and-phone.md#keyboard-shortcuts) in the web app.
