# ClipSync

**Live at [clip.rfh.et](https://clip.rfh.et)**

Encrypted clipboard sync across your own machines. Copy on one device, paste on
another. Built on Cloudflare Workers, D1 and Durable Objects.

The Worker never sees your clipboard. Text is encrypted on the device that
copied it and decrypted on the device that pastes it; what reaches Cloudflare is
an opaque ciphertext envelope.

```
  PC agent ────┐                    ┌─ Worker (Hono)  ── D1   (ciphertext history)
               ├── HTTPS / WSS ─────┤
  Laptop agent ┤                    └─ SyncRoom DO    ── WebSocket fan-out
               │
  Browser ─────┘                       static assets  ── React UI (same origin)
```

## Status

v0.1 — text, images and files, real-time sync, encrypted history, device
pairing and revocation. The agent runs on Linux, macOS and Windows; the tray
panel on Linux. Copied images sync through the clipboard like text, and
files copied in a file manager are sent to history; files also go through
the web UI and `clipsync send` / `clipsync get`.

## Install the agent

On a computer you want to sync, one command downloads the agent, checks it,
links the computer to your account by QR, and starts it at every login:

```bash
curl -fsSL https://clip.rfh.et/install.sh | sh        # Linux, macOS
```

```powershell
irm https://clip.rfh.et/install.ps1 | iex             # Windows, in PowerShell
```

Scan the QR it shows with a device that is already set up (or open the
link it prints there). Run the same command again to upgrade. The first
device of a new account is set up with `clipsync login` instead; see
"Adding a device" below. Details: [Standalone binary](#standalone-binary).

## Quick start (local)

```bash
npm install
```

```bash
npm run db:migrate:local
```

Set a local admin secret in `apps/worker/.dev.vars` (copy `.dev.vars.example`),
then run the Worker — this builds the web UI and serves it from the same origin
as the API:

```bash
npm run dev
```

In a second terminal, enrol this machine and start syncing:

```bash
npm run build -w @clipsync/agent
```

```bash
node apps/agent/dist/clipsync.mjs login --url http://127.0.0.1:8787
```

```bash
node apps/agent/dist/clipsync.mjs run
```

Copy something. It appears at http://127.0.0.1:8787 and on every other paired
device.

To use the deployed instance instead, point the agent at it:

```bash
node apps/agent/dist/clipsync.mjs login --url https://clip.rfh.et
```

## Deploy

Already deployed to `clip.rfh.et`. To stand up your own instance:

```bash
npx wrangler login
```

Create the database and paste the printed `database_id` into
`apps/worker/wrangler.jsonc`:

```bash
npm run db:create
```

```bash
npm run db:migrate
```

Create the R2 bucket that holds encrypted images and files. The name must
match `r2_buckets` in `wrangler.jsonc`:

```bash
npx wrangler r2 bucket create clipsync-blobs
```

Set the admin secret — this is what authorises the very first device:

```bash
npx wrangler secret put ADMIN_SECRET --config apps/worker/wrangler.jsonc
```

```bash
npm run deploy
```

### Running it yourself (no Cloudflare)

The same server runs on any machine: a home server, a NAS, a Raspberry Pi,
a VPS. It keeps everything in one directory: a SQLite database and the
encrypted files. The standalone `clipsync` binary carries it, web UI
included, so the download that runs the agent also runs the server:

```bash
clipsync serve --data /var/lib/clipsync
```

Or, on Node 22 or later, build it from a checkout:

```bash
npm ci
npm run build -w @clipsync/web
npm run build -w @clipsync/server
node apps/server/dist/clipsync-server.mjs --data /var/lib/clipsync
```

`apps/server/dist/` is self-contained (the server plus the web UI), so it can
be copied to the machine that runs it. Both take the options below
(`clipsync serve --help`). On first start the server generates
an admin secret and keeps it in `<data>/admin-secret`, unless
`CLIPSYNC_ADMIN_SECRET` is set; the first device enrols with it, as with
`wrangler secret put ADMIN_SECRET` above.

| Option | Default | |
| --- | --- | --- |
| `--data` | `./clipsync-data` | database and files |
| `--listen` | `127.0.0.1:8787` | address to bind |
| `--trust-proxy` | off | behind a reverse proxy: client address, scheme and host from `X-Forwarded-*` |
| `--storage` | 5 GiB | most bytes of encrypted files to hold; the oldest unpinned are evicted |

Or as a container, for amd64 and arm64, published with each release:

```bash
docker run -d --name clipsync --restart unless-stopped \
  -p 8787:8787 -v clipsync:/data ghcr.io/robavelii/clipsync
docker exec clipsync cat /data/admin-secret
```

It keeps everything in the `/data` volume and runs as an unprivileged
user (uid 1000). With a host directory instead of a named volume
(`-v /srv/clipsync:/data`), that directory must be writable by uid 1000. Pass options after the image name (`--trust-proxy`), or set them in
the environment (`CLIPSYNC_ADMIN_SECRET`, `CLIPSYNC_TRUST_PROXY=1`,
`CLIPSYNC_STORAGE_BYTES`). To move it off port 8787 inside the container,
set `CLIPSYNC_LISTEN=0.0.0.0:<port>` rather than `--listen`, so the image's
health check follows. `docker build -t clipsync .` builds the same image
from a checkout.

#### HTTPS, three ways

Agents work over plain HTTP. The web UI doesn't: anywhere but `localhost`
a browser keeps WebCrypto, the clipboard API and service workers to secure
contexts, so the page can't unlock the vault over HTTP. Pick one:

**1. A reverse proxy with a certificate** (a VPS, or a home server with a
domain and ports 80 and 443 forwarded). Caddy gets the certificate itself:

```
# Caddyfile
clip.example.org {
	reverse_proxy 127.0.0.1:8787
}
```

Run the server with `--trust-proxy` (`CLIPSYNC_TRUST_PROXY=1`) behind any
proxy on the same machine. Without it, every request seems to come from
`127.0.0.1`, which the rate limits exempt (they exist for the public
endpoints: bootstrap, pairing, invites, link requests), and links the
server builds say `http`. With it, the server takes the client's address
and the scheme from the proxy's `X-Forwarded-*` headers. Never pass it
without a proxy in front: anyone could then claim any address.
`deploy/server/` sets this up on Ubuntu (see Staging below).

**2. `tailscale serve`**, with nothing open to the internet:

```bash
clipsync serve --data ~/clipsync-data --trust-proxy
tailscale serve --bg 8787
```

The server is then at `https://<machine>.<tailnet>.ts.net`, with a
certificate Tailscale provides (turn on HTTPS certificates in the
tailnet's settings first). Only devices on your tailnet can reach it, so a
phone needs the Tailscale app too.

**3. HTTP on the LAN, agents only.** For a server no browser will use:

```bash
clipsync serve --data ~/clipsync-data --listen 0.0.0.0:8787
clipsync login --url http://192.168.1.20:8787     # on each computer
```

Clips stay encrypted on the wire, as everywhere. But each device's bearer
token travels in the clear, so anyone on the network who captures one can
act as that device: list and delete clips, or revoke devices. They still
can't read a clip. Use it on a network you trust, and prefer 1 or 2.

Back up by copying the data directory, or online with
`sqlite3 clipsync.db ".backup backup.db"` plus `blobs/`. Decisions §38
covers how this server relates to the Worker.

### Staging

`staging.clip.rfh.et` runs that server on an Oracle Cloud Ubuntu instance
it shares with other apps. `deploy/server/` sets such a machine up, and
works on any Ubuntu 22.04 or 24.04 host, x64 or arm64:

```bash
scp -r deploy/server host:clipsync-setup
ssh host sudo sh clipsync-setup/setup.sh staging.example.org clipsync-setup/deploy-key.pub
```

It installs Node and Caddy (each checked against its release's checksums),
the server as `clipsync-server.service` on `127.0.0.1:8787`, a nightly
backup, and a `clipsync-deploy` user whose key can only run the deploy
script. Caddy is the machine's one proxy: `/etc/caddy/Caddyfile` imports
`/etc/caddy/sites/*.caddy`, and ClipSync owns only `clipsync.caddy`, so
other apps add a file of their own. If another proxy already holds 80 or
443, setup.sh leaves Caddy off and says so; move that app's site into
`sites/`, stop its proxy, then `systemctl enable --now caddy` (decisions
§39). Run setup.sh again at any time; it changes only what is missing.

Every push to `main` that passes CI builds the server and installs it with
`clipsync-deploy`, which switches back to the previous build if the new one
does not answer `/api/health` within 30 seconds. That job needs three
repository secrets:

- `STAGING_SSH_KEY`: the private half of the deploy key given to setup.sh.
- `STAGING_HOST`: the machine's address.
- `STAGING_KNOWN_HOSTS`: its host key, from
  `ssh-keyscan -t ed25519 <host>`.

The first device enrols with the admin secret in
`/var/lib/clipsync/admin-secret`. On a machine already enrolled elsewhere,
give the staging agent its own config:
`XDG_CONFIG_HOME=~/.config/clipsync-staging clipsync login --url https://staging.example.org`.

Snapshots land in `/var/backups/clipsync/<time>/` at 03:17 UTC and are kept
for 14 days; set `BACKUP_UPLOAD` in `/etc/clipsync/backup.env` to copy each
one off the machine. To restore one: stop `clipsync-server`, delete
`clipsync.db-wal` and `clipsync.db-shm` from `/var/lib/clipsync`, copy the
snapshot's `clipsync.db` there and unpack its `blobs.tar.gz` in the same
place, `chown -R clipsync:clipsync /var/lib/clipsync`, and start it again.

### Deploying from CI

Every push to `main` that passes CI (typecheck, unit tests, e2e) applies any
new migrations to the production database, then deploys the Worker, then
checks that it answers. It needs two repository secrets (Settings → Secrets
and variables → Actions):

- `CLOUDFLARE_API_TOKEN`: a token from the **Edit Cloudflare Workers**
  template, plus **Account → D1 → Edit** for migrations. Scope it to your
  account and to the Worker's zone, which needs **Zone → Workers Routes →
  Edit** for the custom domain.
- `CLOUDFLARE_ACCOUNT_ID`: from the dashboard's Workers & Pages sidebar, or
  `npx wrangler whoami`.

Without them the deploy job fails and says so; the checks still run. Runs
on `main` queue rather than cancel each other, so a deploy is never cut off
between its migration and the deploy itself. The staging deploy (above)
runs beside this one, on its own secrets.

`wrangler.jsonc` binds the Worker to `clip.rfh.et` as a custom domain and sets
`workers_dev: false` — one public door, not two. Change the `routes` entry for
your own hostname, or set `workers_dev: true` to use the generated
`*.workers.dev` URL instead.

## Adding a device

The first device authenticates with `ADMIN_SECRET`. After that, there are two
ways to add one.

### Scanning (phones, tablets, any browser)

On a machine that is already set up:

```bash
clipsync invite
```

It prints a QR. Scan it with the phone's camera and you are done — no
passphrase, no code, nothing to type but a device name.

The QR carries a one-time secret, and the vault key is sealed under it before
it ever reaches the server, so there is nothing to compare and nothing the
server could substitute. The trade is that the code on screen *is* the
credential: it lasts five minutes and works once.

A phone gets every clip, and the newest from another device sits in a card
at the top, one tap from the clipboard (images included). No browser lets a
page read the clipboard by itself, so sending *from* a phone is a deliberate
act:

- **Share → ClipSync** (Android, once the app is installed): text, links,
  photos and files, encrypted on the phone before they leave it.
- **Paste to ClipSync:** when you come back to the app after copying
  something, a bar at the bottom sends what is on the clipboard, text or an
  image, in one tap.
- **A Shortcut** (iPhone), run from Back Tap or the Action Button, that sends
  the clipboard's text.

`/phone` on your deployment walks through each (decisions §35).

### Linking (another computer, no passphrase typing)


For a second computer running the agent, the QR goes the other way — the
joining machine shows it:

```bash
clipsync link --url https://clip.rfh.et
```

It prints a QR code and a URL, plus a six-digit code. On a machine that is
already set up, either open that URL in the web UI, or:

```bash
clipsync approve https://clip.rfh.et/link#...
```

Check that the six-digit code matches on both screens, approve, and the new
device is running. Nobody types the passphrase.

**Why the code matters.** The new device generates a throwaway keypair and the
approving device seals your passphrase to it, so the server relays ciphertext
it cannot open. The one attack left is a server that swaps in its own public
key — which is why the key travels out of band, in the QR or the URL fragment,
and why both ends show a fingerprint of it. Matching codes mean no substitution
happened. Mismatched codes mean stop.

### Pairing codes (manual fallback)

Useful when the two machines cannot see each other's screens:

```bash
clipsync pair-code
```

```bash
clipsync pair PAIR-XXXX-XXXX --url https://clip.rfh.et
```

This one *does* require typing the same passphrase on the new device. It is the
only key to your history and nothing on the server can recover it; both the CLI
and the web UI check it against existing clips and warn immediately rather than
letting you discover the mistake later.

## CLI

| Command | Purpose |
|---|---|
| `clipsync login --url <url>` | Create the account and enrol this device |
| `clipsync invite` | Show a QR for a phone or browser to scan |
| `clipsync link --url <url>` | Join another computer by QR |
| `clipsync approve <link-url>` | Approve a device that ran `clipsync link` |
| `clipsync pair <code> --url <url>` | Join with a pairing code (manual) |
| `clipsync pair-code` | Mint a code for another device |
| `clipsync run` | Watch the clipboard and sync (the daemon) |
| `clipsync history [-n 20] [--full]` | Recent clips, decrypted locally; `--full` prints them untruncated |
| `clipsync copy <clip-id>` | Put an old clip back on this clipboard |
| `clipsync send <file>` | Send an image or file to your devices |
| `clipsync get <clip-id> [-o path]` | Save an image or file clip (never overwrites) |
| `clipsync receive [on\|off] [--to dir]` | Save files from your other devices here, ready to paste (off by default) |
| `clipsync passphrase` | Change the passphrase |
| `clipsync-desktop` | Tray panel (see below) |
| `clipsync devices [--revoke <id> [--rekey]]` | List or revoke devices; `--rekey` re-keys straight after |
| `clipsync rekey [--finish]` | Move every device to a new vault key (see below) |
| `clipsync status` | Config, clipboard backend, token validity |
| `clipsync watch` | Print each clipboard change as it happens: shows whether the agent hears of copies or polls |
| `clipsync logout` | Revoke this machine's devices, then forget local credentials |
| `clipsync install [--dry-run]` | Run the agent in the background at every login (see below) |
| `clipsync uninstall` | Stop and remove that background service |
| `clipsync serve [--data dir] [--listen host:port]` | Run the ClipSync server itself, web UI included (see Running it yourself) |

`clipsync run` does not push whatever happened to be on the clipboard when it
started; pass `--push-current` if you want that.

### The tray panel

`clipsync-desktop` is a tray icon with a searchable history: click a clip to
copy it, pin it or delete it. It needs no setup beyond `clipsync login`. It
takes the vault keys from the agent's config and, on first run, enrols itself as
a second device named after this one, `rob (tray)` for instance, saving its
token and its own device key to `~/.config/clipsync/tray.json`. After a re-key
it fetches its own copy of the new key, whether or not the agent is running.

It is a separate device so that clips copied on this machine appear in it live.
Revoking it from another device stops the panel rather than letting it quietly
re-enrol; delete `tray.json` and reopen to enrol it again.

**Opening it.** Press `Ctrl+Alt+V` anywhere: the panel opens at the pointer
with the newest clip highlighted. Type to search, `↑`/`↓` to move, `Enter` to
copy and close, `Esc` to close. The tray menu (**Open ClipSync**) works too;
on Ubuntu a left click on a tray icon does nothing.

The shortcut is deliberately not `Ctrl+Shift+V`, which is paste in every Linux
terminal. To use another, add it to `tray.json` and restart the panel:

```json
"shortcut": "Super+Shift+V"
```

Running `clipsync-desktop` while it is already running toggles the panel
instead of starting a second one. On Wayland, where apps cannot grab global
shortcuts, bind that command to a key in your desktop's keyboard settings.

### Standalone binary

Every release publishes `clipsync` as a single executable that carries its
own Node (24), so a machine needs no Node, npm or checkout to run it. There
are builds for Linux (x64, arm64, glibc 2.28 or later), macOS (Apple
Silicon, Intel; macOS 13.5 or later) and Windows (x64, Windows 10 or
later), each checked against a `SHA256SUMS` file. Linux still needs `xclip`
or `wl-clipboard`. A Mac on an older macOS keeps the last release built on
Node 22: its updater finds that the new binary won't start, and stays put.

The installers above (`/install.sh`, `/install.ps1`, served by the Worker
from `scripts/`) do these steps. By hand:

```bash
base=https://github.com/robavelii/clipboard-worker/releases/latest/download
curl -fsSLO "$base/clipsync-linux-x64.tar.gz" -fsSLO "$base/SHA256SUMS"
sha256sum --ignore-missing -c SHA256SUMS
tar -xzf clipsync-linux-x64.tar.gz
./clipsync link --url https://clip.rfh.et
./clipsync install
```

The installers take a few settings from the environment: `CLIPSYNC_VERSION`
(a release tag instead of the latest), `CLIPSYNC_LINK=0` (install now,
`clipsync link` later) and `CLIPSYNC_DOWNLOAD_BASE` (a mirror of the release
files). The Windows one also adds the install folder to your user PATH. The
Worker fills in its own address, so a self-hosted Worker's installer links
to itself; `RELEASES_REPO` in `wrangler.jsonc` names the GitHub repo whose
releases it downloads.

`clipsync install` copies the binary to `~/.local/bin/clipsync`
(`%LOCALAPPDATA%\Programs\clipsync\clipsync.exe` on Windows) and starts it
as a service at every login: a systemd user unit on Linux, a launchd agent
on macOS, a Task Scheduler task on Windows. Running it again installs the
binary it is run from, and the running agent restarts onto it.
`clipsync uninstall` stops and removes the service; `clipsync status` shows
its state.

**Updates.** An installed release keeps itself current. The service checks
for a newer release a minute after it starts and then daily, downloads it
from this repo's GitHub releases, checks it against `SHA256SUMS`, and
restarts onto it. `clipsync update` does the same now.
`CLIPSYNC_AUTO_UPDATE=off` in the service's environment stops the automatic
checks. The agent only ever looks at the releases it was built from, never
at an address the server gives it, and never moves to an older release. A
build from a checkout is not updated this way: `git pull` and
`scripts/install-agent.sh` update it.

When a change would be mishandled by older agents, raise `MIN_AGENT_VERSION`
in `wrangler.jsonc`. The Worker then refuses writes from older releases
(they can still connect, read and receive), and each of them updates itself
as soon as it is refused.

The macOS builds are signed ad hoc, not notarized. A copy downloaded with a
browser needs `xattr -d com.apple.quarantine clipsync` before macOS will run
it; one fetched with `curl` does not. The Windows build is unsigned, so
SmartScreen may ask before the first run.

To build one for this machine, run `npm run build:binary`. The result is at
`apps/agent/dist/bin/<os>-<arch>/clipsync`. To publish a release, push a tag:

```bash
git tag v0.2.0 && git push origin v0.2.0
```

The Release workflow builds all five on their own platforms, runs each one,
and attaches them to a GitHub Release. It also builds them, without
publishing anything, on every pull request that touches the agent.

### Running it as a service

`clipsync install` sets up the service for whichever `clipsync` runs it: a
release binary (above), or the bundle in a checkout. From a checkout, the
script does that and more:

```bash
scripts/install-agent.sh
```

Builds the agent and, when a Rust toolchain is present, the tray app; puts
`clipsync` and `clipsync-desktop` on your PATH; runs `clipsync install` and
adds a tray autostart entry; then restarts both so they run the code just built.
Re-run it after pulling changes. `--no-tray` skips the tray build, which takes
a few minutes, and `--uninstall` reverses everything. Needs no root.

The service runs the bundle straight from the checkout, and restarts itself
when that bundle is rebuilt: `npm run build -w @clipsync/agent` is enough to
put a change into the running agent. `clipsync status` prints the commit the
CLI was built from, the service logs it on startup, and hovering the device
name in the tray panel shows the panel's.

```ini
# ~/.config/systemd/user/clipsync.service (abridged)
[Unit]
After=graphical-session.target
PartOf=graphical-session.target

[Service]
ExecStart=/path/to/node /path/to/clipsync/apps/agent/dist/clipsync.mjs run
Restart=on-failure
RestartSec=5
# Exit 75 is the agent handing over to a rebuilt bundle, not a crash.
SuccessExitStatus=75
RestartForceExitStatus=75
# Exit 78: this device was revoked, re-keyed out, or never enrolled;
# restarting cannot fix that.
RestartPreventExitStatus=78

[Install]
WantedBy=graphical-session.target
```

Logs: `journalctl --user -u clipsync -f`.

A service installed before the device is enrolled waits: the agent exits 78
until `clipsync link` (or `login`, or `pair`) enrols it, which restarts the
service.

**macOS.** `clipsync install` sets up a launchd agent instead
(`~/Library/LaunchAgents/clipsync.agent.plist`, logs in
`~/Library/Logs/clipsync.log`) and skips the tray. The clipboard is read with
`pbpaste`/`pbcopy`, which ship with macOS, under a UTF-8 locale: launchd
starts jobs without one, and without it anything beyond ASCII comes out
mangled. launchd cannot be told to leave one failure status alone, so under
it the agent exits 0 when revoked (launchd leaves a clean exit alone) and 75
onto a rebuilt bundle (which it restarts).

**Windows.** The agent uses one long-lived PowerShell process for the
clipboard (Windows PowerShell 5.1, which every Windows 10 and 11 has; set
`CLIPSYNC_POWERSHELL=pwsh` for PowerShell 7). `clipsync install` registers a
logon task, `ClipSync`, that runs `clipsync supervise` through
`conhost --headless`, so no console window stays open. Task Scheduler cannot
tell one exit status from another, so the supervisor applies systemd's
rules itself: restart at once on 75, stop on 78, restart after 5 s on
anything else. The agent's log is `%LOCALAPPDATA%\clipsync\clipsync.log`.

**Images.** A copied image (a screenshot, a browser's "Copy image") syncs
through the clipboard like text, encrypted and stored the way `clipsync send`
stores a file. Every image up to 25 MB goes to history; other devices put it
on their clipboard if it is 5 MB or less, and the rest stay in history for
the web UI or `clipsync get`. The agent looks for an image only when the
clipboard holds no text (or only the image's web address): after each copy,
or every couple of seconds where it polls. `CLIPSYNC_IMAGES=off` turns this
off.

**Noticing a copy.** Where the clipboard can say it changed, the agent
reads it once the copy settles (100 ms of quiet) and sends it straight away:
between two agents on one machine, a copy reached the other clipboard in
about 150 ms, against about 1.1 s when polling, with a quarter of the idle
CPU. The events come from XFixes on X11, `wl-paste --watch` on Wayland
compositors with the data-control protocol (wlroots ones such as sway; on
GNOME, from XWayland's clipboard instead), `changeCount` on macOS, and
`AddClipboardFormatListener` on Windows. A check every 5 s makes sure none
was missed; if one was, the agent says so and polls from then on, every
0.6 s, as it does wherever there are no events. `clipsync watch` shows
which applies; `CLIPSYNC_WATCH=off` makes the agent poll.

**Files.** Copying files in a file manager (Nautilus, Dolphin, Finder,
Explorer) sends the files themselves, up to 10 at a time and 25 MB each, not
their paths. Images among them land on the other devices' clipboards as
above; other files wait in history. Folders are skipped.
`CLIPSYNC_FILES=off` turns this off.

**Receiving files.** Off by default, because a download nobody asked for is
not a paste. `clipsync receive on` makes this computer save files from your
other devices in `~/Downloads/ClipSync` (your desktop's Downloads folder on
Linux; `--to <dir>` picks another), and put each one on the clipboard as a
file: paste in a file manager (Dolphin, a recent Nautilus, Finder, Explorer)
and the file is there.
A name is never trusted as a path, and an existing file is never replaced:
the same file received again is reused, a different one becomes
`name (1).ext`. The setting lives in the config file, so the background
service sees it; `clipsync receive off` turns it off again.

On macOS both use `osascript`, which reads only the first of several copied
files, and on Windows the PowerShell helper. The Release workflow checks
each against the real clipboard of a macOS and a Windows runner.

`CLIPSYNC_CLIPBOARD` (`wayland`, `x11`, `macos` or `windows`) overrides the
backend the agent picks, if it guesses wrong.

## Security model

What the design actually protects against, and what it does not.

**Protected.** Someone who obtains your D1 database, your R2 bucket or your
Cloudflare account sees ciphertext and HMAC tags. They cannot read your clips,
and they cannot confirm a guess ("was this clip `hunter2`?") because the dedupe
tag is an HMAC under a key they do not hold, not a plain digest.

**Key derivation.** A vault key — 32 random bytes — is what actually protects
clips, via HKDF into `AES-GCM-256` for content and `HMAC-SHA256` for dedupe
tags. The passphrase only unlocks it: `PBKDF2-SHA256`, 600k iterations, over a
public per-account salt, then HKDF to a key-encryption key that wraps the vault
key. The server stores the wrapped form and cannot open it.

That indirection is why `clipsync passphrase` re-wraps 32 bytes instead of
re-encrypting your whole history, and why a device linked by QR can read the
clipboard without ever learning the passphrase.

**Authenticated envelopes.** Each clip's ciphertext is bound to your account
and to a small header saying which device copied it, when, and what kind of
clip it is. The server can read that header, since it knows those things
anyway, but it cannot change it or move a ciphertext into another clip's
place. Devices refuse any clip whose header, row or dedupe tag disagree. The
agent also refuses a clip whose authenticated copy time is more than ten
minutes old, so the server cannot replay an old clip onto your clipboard as
a new copy. Clips stored before this change carry no header until a re-key
re-encrypts them.

**Images and files.** Each file is encrypted under a random key of its own,
in 1 MiB chunks. Each chunk is bound to its file, its position and the chunk
count, so the server cannot reorder, splice or truncate a file. The key, name,
type, size and SHA-256 live in the clip's authenticated envelope, and the
downloader checks the whole file against that digest. A re-key re-seals only
that envelope; the bytes in R2 are never rewritten.

**Scan-to-join.** The vault key is sealed under a 256-bit secret that exists
only in the QR and reaches the scanner through its camera. The server stores
the ciphertext and a SHA-256 of the secret — enough to check who may claim the
invite, not enough to open it. Invites last five minutes and are single-use.

**Device linking.** Transfers the vault key, not the passphrase, so a linked
device never learns the passphrase and cannot change it: the server replaces
the wrapped key only with proof of the current passphrase (see below). ECDH
over P-256, with both public keys bound into the HKDF
info so a swapped transcript derives a different key and fails closed. The
server sees two public keys and one ciphertext. The joining device's key
travels out of band and both ends display a fingerprint of it, which is what
closes the key-substitution attack. Link requests expire in ten minutes, the
pickup token is single-use, and the claiming read deletes the row.

**Tokens.** Device tokens are 256-bit random strings stored only as SHA-256
digests. Revoking a device invalidates its token immediately; re-keying
afterwards (below) makes sure the vault key it kept opens nothing new. The WebSocket uses
a separate single-use 30-second ticket, because browsers cannot set headers on a
handshake and a long-lived token in a URL ends up in logs.

**Unauthenticated endpoints** — bootstrap, pairing, invite claims and link
requests — are rate-limited per client address, and pending link requests are
capped per address rather than globally, so no one can lock others out of
linking. Invite proofs are hashed again before they are stored.

**The web UI** is served with a strict Content-Security-Policy (this origin
only, no inline script or style), refuses to be framed, and sends no referrer.
It can keep the vault key in browser storage on a phone, so script injection
is the attack those headers are there for.

**Re-keying.** Every device holds a P-256 device key; the server has only the
public half. A re-key generates a fresh vault key, wraps it under the
passphrase, and seals a copy to each active device's public key, binding the
device id and key epoch into the derivation so the server cannot hand one
device another's copy or pass off an old key as new. Revoked devices get
nothing. The server refuses writes under a key it has moved past.

**Not protected.** The agent stores the vault keys and its device key in
`~/.config/clipsync/config.json` at mode 0600 so it can start unattended.
Anyone who can read that file can also read your clipboard directly, so this
does not weaken the threat model the encryption addresses — but it does mean
local disk compromise is game over. Set `CLIPSYNC_PASSPHRASE` instead if you
would rather keep keys out of the file; the agent then unwraps the key at
startup and picks up re-keys through the passphrase.

The server also learns metadata it cannot avoid: how many clips you make, when,
from which device, and roughly how large they are.

## Changing the passphrase

```bash
clipsync passphrase
```

Re-wraps the vault key. No clip is re-encrypted, and your other devices keep
working without doing anything — they hold the vault key, not the passphrase.

It asks for the current passphrase first (or reads `CLIPSYNC_PASSPHRASE`).
Holding the vault key is enough to wrap it under a passphrase of your choosing,
so the server stores a hash of a proof derived from the passphrase and accepts
a new wrapped key only with that proof. A phone that joined by QR can read your
clipboard, but it cannot lock you out of it.

Accounts that predate the proof register it the next time the passphrase is
used — the web UI's unlock, `clipsync login`, or a `CLIPSYNC_PASSPHRASE` agent
starting. Do that once after upgrading: until then, the first device to
register a proof holds the right to change the passphrase.

One caveat for accounts created before the vault key existed: their vault key
*is* the old passphrase-derived value, so someone who knows the original
passphrase can still recompute it. Changing the passphrase locks out the web UI
and any `CLIPSYNC_PASSPHRASE` device, but it does not fully retire the old
secret. `clipsync rekey` retires it: a fresh random vault key, and history
re-encrypted under it. Accounts created after this change get a random vault
key and do not have the problem.

## Re-keying after a revoke

```bash
clipsync devices --revoke <id> --rekey     # or: clipsync rekey
```

Revoking a device stops its token at once, but it still holds the vault key it
was given, and that key opens every clip it could get hold of — a copy of the
database, say. A re-key moves the account to a new vault key and re-encrypts
history under it, so the revoked device's key opens nothing written since and
nothing already stored.

It needs the passphrase. Every other device keeps working without anything to
type: agents, the tray and browsers pick up their sealed copy of the new key
as soon as they hear about it (or the next time they start). A device that
never registered a device key — one that has not run since this was added —
is listed at the end; it can still read old clips but not new ones, so enrol
it again (a browser can just unlock with the passphrase).

Re-encryption runs straight after the switch. If it is interrupted,
`clipsync rekey --finish` resumes it, from any device holding the old key; it
is safe to run twice.

## Retention

Identical content is stored once. Copying something you copied last week moves
that entry back to the top rather than adding a second row, so history does not
fill with duplicates and a clip you deleted does not quietly return the next
time you copy it.

Text clips expire after 30 days, images and files after 7, and an hourly cron
deletes them along with their bytes in R2. Pinned clips never expire.
Clipboard history accumulates API tokens and passwords whether or not you
intend it to, so the default is to forget.

**Staying inside R2's free tier.** R2 has no spending cap of its own, so the
Worker keeps a budget at half the free tier and enforces it itself: it is the
only thing that touches the bucket. The budget is set in `vars` in
`wrangler.jsonc`:

| | Free tier | Budget | Past it |
|---|---|---|---|
| Storage | 10 GB-month | 5 GB held at any moment | the oldest unpinned files are deleted to make room |
| Uploads (Class A) | 1M a month | 500k a month | refused until the 1st |
| Downloads (Class B) | 10M a month | 5M a month | refused until the 1st |

A new file is refused only when pinned files alone fill the storage budget.
Uploads that never became a clip are swept after an hour, and files are
limited to 25 MB. `clipsync status` shows how much of each budget this month
has used.

## Repository layout

```
packages/protocol   Wire types shared by all three surfaces
packages/crypto     Envelope encryption — one implementation, three runtimes
packages/client     Typed API client shared by the agent and the web UI
packages/react      Hooks shared by the web UI and the tray app
apps/worker         Hono API, SyncRoom Durable Object, cron, static assets
apps/web            React + Vite UI, served by the Worker
apps/agent          Node CLI and clipboard daemon
apps/server         The Worker's app on Node: SQLite, files on disk, no Cloudflare
scripts/e2e.ts      End-to-end smoke test against a running Worker
```

The shared packages exist because the same envelope format has to be produced
and consumed by a Worker, a browser and a Node process. Three hand-written
implementations of the same AES-GCM framing is where crypto bugs come from.

## Tests

```bash
npm run test
```

Unit tests for the crypto envelope and the linking handshake — round-trips,
tampering, wrong passphrase, the property that dedupe tags differ across
passphrases, and that a substituted public key fails closed.

```bash
npm run e2e
```

About a hundred and fifteen checks against a running `npm run dev`, or the Node server (`CLIPSYNC_URL` picks which): bootstrap, pairing,
single-use codes and tickets, dedupe, size limits, live WebSocket delivery,
revocation including cutting off an open socket, the full linking handshake
including a refused key substitution,
scan-to-join including a refused claim that knows only the invite id,
passphrase rotation leaving old clips readable, a re-key after revocation
(sealed copies, re-encrypted history, stale writes refused), and an explicit
assertion that no plaintext appears in any API response.

## Not built yet

Putting a received file (other than an image) on another computer's
clipboard (it waits in history for the web UI and the CLI), semantic search, signed
releases, and the tray panel on macOS and Windows.

Search is deliberately client-side: the server holds ciphertext, so there is
nothing for SQL `LIKE` to match. Server-side search needs a blind index or
encrypted vector search — a separate design decision, not an incremental one.
