---
title: Troubleshooting
description: Fixes for the problems people actually hit.
---

# Troubleshooting

Start with:

```bash
clipsync status       # enrolled? which server? which clipboard backend? is the service running?
clipsync watch        # does this machine report clipboard changes, or does it poll?
```

## Copies don't sync from this computer

- **Is the agent running?** `clipsync status` says. If not, `clipsync install`,
  then check the logs: `journalctl --user -u clipsync -f` on Linux,
  `~/Library/Logs/clipsync.log` on macOS, `%LOCALAPPDATA%\clipsync\clipsync.log`
  on Windows.
- **Linux: no clipboard tool.** Install `wl-clipboard` (Wayland) or `xclip`
  (X11). `clipsync status` names the backend it found.
- **Wrong backend.** Under XWayland, or in a remote session, the agent can guess
  wrong. Set `CLIPSYNC_CLIPBOARD=x11` or `wayland` in the service's environment.
- **Copies arrive late.** `clipsync watch` shows whether the machine reports
  changes. If it polls, a copy takes up to a second or so. That's expected on
  GNOME under Wayland without XWayland.

## The service stopped and won't restart

It exited with 78: the device was revoked, the account was re-keyed without a
copy for this device, or it was never enrolled. Restarting can't fix those, so
it doesn't try. Enrol again:

```bash
clipsync link --url https://clip.rfh.et
```

## "Unknown option" or "no such file or directory"

- Run one command at a time. `clipsync passphrase --reset, clipsync email …` is
  read as one command with an option `--reset,`.
- `<id>`, `<url>` and `<address>` in the docs are placeholders. In zsh and bash,
  typing the angle brackets makes the shell treat them as a redirect from a file.
  Type the value itself.

## "Unknown command" on an older install

Your `clipsync` is older than the docs. A release binary updates itself daily;
run `clipsync update` to do it now. A build from a checkout doesn't: pull and
re-run `scripts/install-agent.sh`.

## Forgot the passphrase

With the recovery key: `clipsync recover --url …`, or **Forgot the
passphrase?** in the web app. Without it, the server's operator can reset it
from one of your devices. See [Passphrase and recovery](passphrase-and-recovery.md#forgot-the-passphrase).

## The six-digit codes don't match when linking

Don't approve. Cancel, and run `clipsync link` again. If they differ again,
something between the devices and the server is swapping keys.

## "Too many pending link requests"

A server allows three unapproved link requests per address at a time, for ten
minutes. Approve or wait out the ones you started. On a local development
server, where every request shares one address, clear them:

```bash
cd apps/worker && npx wrangler d1 execute clipsync --local --command "DELETE FROM link_requests"
```

## The web app won't unlock on my own server

Browsers allow the features it needs only over HTTPS (or on `localhost`). Put
the server behind a proxy with a certificate, or use `tailscale serve`; see
[Self-hosting](self-host.md#https).

## macOS won't open the binary

A copy downloaded with a browser is quarantined. Remove the flag:

```bash
xattr -d com.apple.quarantine clipsync
```

## Signup says mail isn't set up

The server has no way to send the code. Ask its operator for an invite, or set
up [mail](mail.md) if it's yours.

## A file didn't land on the other clipboard

Only images of 5 MB or less are put on other clipboards by default. Other files
wait in history: `clipsync get <id>`, or the web app. To have a computer save
them ready to paste, `clipsync receive on`. See [Images and files](files.md#receiving-files-ready-to-paste).

## The tray shortcut does nothing on Wayland

Wayland doesn't let apps grab global shortcuts. Bind `clipsync-desktop` to a key
in your desktop's keyboard settings; running it toggles the panel.
