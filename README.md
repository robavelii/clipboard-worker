# ClipSync

**End-to-end encrypted clipboard sync for your own devices.** Copy on one,
paste on another. The server only ever sees ciphertext.

[Open ClipSync](https://clip.rfh.et) · [Documentation](https://clip.rfh.et/docs/) · [Releases](https://github.com/robavelii/clipboard-worker/releases)

```
  laptop agent ──┐                       ┌─ API (Hono)       ── database (ciphertext history)
                 ├──── HTTPS / WSS ──────┤
  desktop agent ─┤                       ├─ sync room        ── WebSocket fan-out, one per account
                 │                       │
  phone browser ─┘                       └─ static web app   ── same origin as the API
```

Text, screenshots and files copied on one device reach the others in well
under a second, with a searchable history in between. Everything is encrypted
on the device that copied it, under a key the server never has. Whoever runs
the server, Cloudflare included, stores and relays bytes they cannot read.

## Features

- **Live sync** of text, images and files, on Linux, macOS and Windows, with a
  background agent that hears copies as they happen.
- **A phone that joins by scanning a QR code.** It installs as an app, with a
  share sheet on Android and one-tap copy of the latest clip.
- **History** in the web app, on the command line and in a tray panel: search,
  pin, open links, keyboard shortcuts. Text is forgotten after 30 days and files
  after 7, unless pinned.
- **Recovery without a back door.** A recovery key you keep, re-keying after a
  lost device, and export and account deletion.
- **Run it anywhere.** The hosted service, your own Cloudflare account, or one
  binary or Docker image on a machine you own.

## Get started

Make an account at [clip.rfh.et](https://clip.rfh.et), then on each computer:

```bash
curl -fsSL https://clip.rfh.et/install.sh | sh        # Linux, macOS
```

```powershell
irm https://clip.rfh.et/install.ps1 | iex             # Windows, in PowerShell
```

The installer checks the download against the release's checksums, shows a
code to approve from a device you already use, and starts the agent at every
login. To add a phone, choose **Add device** in the web app and scan the QR.

Full walkthrough: [Quick start](apps/web/docs/quickstart.md).

## Run your own server

```bash
clipsync serve --data /var/lib/clipsync                                   # the same binary
docker run -d -p 8787:8787 -v clipsync:/data ghcr.io/robavelii/clipsync    # or the image
```

Everything lives in one directory: a SQLite database and the encrypted files.
See [Self-hosting](apps/web/docs/self-host.md), or
[Deploy to Cloudflare](apps/web/docs/cloudflare.md) for Workers, D1, Durable
Objects and R2.

## Documentation

The docs are served at [clip.rfh.et/docs](https://clip.rfh.et/docs/) and every
server you run serves its own copy at `/docs`. The Markdown sources are in
[`apps/web/docs/`](apps/web/docs/).

| | |
| --- | --- |
| Using it | [Adding devices](apps/web/docs/devices.md) · [Web app and phone](apps/web/docs/web-and-phone.md) · [The desktop agent](apps/web/docs/agent.md) · [Images and files](apps/web/docs/files.md) · [Tray panel](apps/web/docs/tray.md) · [Passphrase and recovery](apps/web/docs/passphrase-and-recovery.md) · [Your account](apps/web/docs/account.md) · [Plans and limits](apps/web/docs/limits.md) |
| Running a server | [Self-hosting](apps/web/docs/self-host.md) · [Deploy to Cloudflare](apps/web/docs/cloudflare.md) · [Mail](apps/web/docs/mail.md) |
| Reference | [CLI](apps/web/docs/cli.md) · [Configuration](apps/web/docs/configuration.md) · [HTTP API](apps/web/docs/api.md) |
| How it works | [Architecture](apps/web/docs/architecture.md) · [Security model](apps/web/docs/security.md) |
| Help | [Troubleshooting](apps/web/docs/troubleshooting.md) · [Development](apps/web/docs/development.md) |

## Security in one paragraph

A random 32-byte vault key encrypts every clip (AES-GCM-256, with an
authenticated header naming the device, time and type) and keys the HMAC
dedupe tags. The passphrase only unwraps that key (PBKDF2, 600k iterations)
and never leaves the device it is typed on. New devices receive the key sealed
under a one-time QR secret or over ECDH with a fingerprint check, so nobody
types the passphrase twice and the server relays only what it cannot open.
The [security model](apps/web/docs/security.md) says exactly what is and isn't
protected.

## Development

```bash
npm ci
npm run typecheck
npm test
cp apps/worker/.dev.vars.example apps/worker/.dev.vars && npm run db:migrate:local
npm run dev            # API, web app and docs on http://127.0.0.1:8787
npm run e2e            # about a hundred end-to-end checks against it
```

```
packages/protocol   wire types and constants
packages/crypto     envelope encryption: one implementation for Worker, browser and Node
packages/client     the API client and shared flows (unlock, link, invite, re-key, files)
packages/react      hooks shared by the web app and tray
apps/worker         Cloudflare Worker: API, sync room, cleanup, static files
apps/server         the same server on Node, and inside the clipsync binary
apps/web            the web app, and the docs (apps/web/docs)
apps/agent          the clipsync CLI and clipboard daemon
apps/desktop        the Tauri tray panel
```

More in [Development](apps/web/docs/development.md). Why each part works the
way it does is in [`docs/decisions.md`](docs/decisions.md).
