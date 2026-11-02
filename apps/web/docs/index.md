---
title: ClipSync
nav: Overview
description: End-to-end encrypted clipboard sync for your own devices. Copy on one, paste on another. The server only ever sees ciphertext.
---

# ClipSync

ClipSync keeps one clipboard across your computers and phone. Copy text, a
screenshot or a file on one device and it is on the others a moment later,
with a searchable history of everything you copied.

Everything is encrypted on the device that copied it and decrypted on the
device that pastes it. The server, whether that is [clip.rfh.et](https://clip.rfh.et) or one you
run yourself, stores and relays ciphertext it has no key for.

## What you get

- **Live sync.** A copy reaches your other computers in well under a second,
  over one WebSocket per device.
- **History.** Every clip, searchable and pinnable, in the web app, the
  `clipsync history` command and the tray panel. Unpinned text is forgotten
  after 30 days, images and files after 7.
- **Images and files.** Screenshots and copied images sync through the
  clipboard like text. Files copied in a file manager are sent too, and can be
  saved on the other side, ready to paste.
- **Every platform.** A background agent for Linux, macOS and Windows, a web
  app that installs on a phone (with a share sheet on Android), and a tray
  panel on Linux.
- **Adding a device takes a scan.** Point a phone at a QR code, or approve a
  new computer from one you already use. Nobody types the passphrase twice.
- **Run it anywhere.** The hosted service, your own Cloudflare account, or one
  binary on a home server, a VPS or Docker.

## Where to start

| If you want to | Read |
| --- | --- |
| Start syncing in five minutes | [Quick start](quickstart.md) |
| Add a phone or another computer | [Adding devices](devices.md) |
| Use it on a phone | [Web app and phone](web-and-phone.md) |
| Understand what the agent does | [The desktop agent](agent.md) |
| Look up a command | [CLI reference](cli.md) |
| Run your own server | [Self-hosting](self-host.md) |
| Know exactly what is protected | [Security model](security.md) |
| Fix something | [Troubleshooting](troubleshooting.md) |

## How it fits together

```
  laptop agent ──┐                       ┌─ API (Hono)       ── database (ciphertext history)
                 ├──── HTTPS / WSS ──────┤
  desktop agent ─┤                       ├─ sync room        ── WebSocket fan-out, one per account
                 │                       │
  phone browser ─┘                       └─ static web app   ── same origin as the API
```

Each device holds the account's **vault key**. Your passphrase only unlocks
that key; it never leaves the device you type it on. The [architecture](architecture.md)
page walks through a copy from one device to another, and the
[security model](security.md) covers what the server can and cannot learn.
