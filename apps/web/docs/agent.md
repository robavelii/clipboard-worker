---
title: The desktop agent
description: What the clipsync agent does on Linux, macOS and Windows, how it runs in the background, and how it stays up to date.
---

# The desktop agent

`clipsync` is one program: the background agent that syncs the clipboard, and
the command line you manage the account with. Each release is a single
executable that carries its own runtime, so a computer needs nothing else
installed (on Linux, a clipboard tool; see below).

## Install

```bash
curl -fsSL https://clip.rfh.et/install.sh | sh        # Linux, macOS
```

```powershell
irm https://clip.rfh.et/install.ps1 | iex             # Windows, in PowerShell
```

The installer downloads the release for this machine, checks it against the
release's `SHA256SUMS`, runs `clipsync link` if this computer isn't enrolled
yet (see [Adding devices](devices.md#link-another-computer)), and then
`clipsync install`. Run it again to upgrade. On Windows it also adds the
install folder to your PATH.

It reads a few settings from the environment:

| Variable | Does |
| --- | --- |
| `CLIPSYNC_VERSION` | install this release tag instead of the newest |
| `CLIPSYNC_LINK=0` | install now, run `clipsync link` later |
| `CLIPSYNC_DOWNLOAD_BASE` | download from a mirror of the release files |

```bash
curl -fsSL https://clip.rfh.et/install.sh | CLIPSYNC_LINK=0 sh
```

### Supported systems

| System | Builds | Needs |
| --- | --- | --- |
| Linux | x64, arm64 | glibc 2.28 or later; `wl-clipboard` (Wayland) or `xclip` (X11) |
| macOS | Apple Silicon, Intel | macOS 13.5 or later |
| Windows | x64 | Windows 10 or later |

### By hand

```bash
base=https://github.com/robavelii/clipboard-worker/releases/latest/download
curl -fsSLO "$base/clipsync-linux-x64.tar.gz" -fsSLO "$base/SHA256SUMS"
sha256sum --ignore-missing -c SHA256SUMS
tar -xzf clipsync-linux-x64.tar.gz
./clipsync link --url https://clip.rfh.et
./clipsync install
```

The macOS builds are signed ad hoc, not notarised. A copy downloaded with a
browser needs `xattr -d com.apple.quarantine clipsync` before macOS runs it; one
fetched with `curl` does not. The Windows build is unsigned, so SmartScreen may
ask before its first run.

## Running in the background

```bash
clipsync install      # copy this binary into place and start it at every login
clipsync status       # is it running, and is this device enrolled?
clipsync uninstall    # stop it and remove the service
```

`clipsync install` copies the binary to `~/.local/bin/clipsync`
(`%LOCALAPPDATA%\Programs\clipsync\clipsync.exe` on Windows) and registers it
with the system's own service manager:

| System | Service | Logs |
| --- | --- | --- |
| Linux | systemd user unit `clipsync.service` | `journalctl --user -u clipsync -f` |
| macOS | launchd agent `~/Library/LaunchAgents/clipsync.agent.plist` | `~/Library/Logs/clipsync.log` |
| Windows | Task Scheduler task `ClipSync`, at logon | `%LOCALAPPDATA%\clipsync\clipsync.log` |

A service installed before the computer is enrolled waits quietly; enrolling
starts it. If the device is revoked, the agent stops for good rather than
restarting in a loop. See [exit codes](configuration.md#exit-codes).

To run it in the foreground instead, for a look at what it does:

```bash
clipsync run --verbose
```

`clipsync run` doesn't send whatever was on the clipboard when it started;
add `--push-current` for that.

## How it notices a copy

Where the system can say the clipboard changed, the agent waits for the copy
to settle (100 ms of quiet), reads it and sends it straight away. A copy
reaches another computer in about 150 ms. The events come from:

- **X11:** XFixes.
- **Wayland:** `wl-paste --watch` on compositors with the data-control
  protocol (sway and other wlroots ones). On GNOME, from XWayland's clipboard
  instead.
- **macOS:** the pasteboard's change count.
- **Windows:** a clipboard format listener.

A check every 5 seconds makes sure none was missed. If one was, the agent says
so and polls every 0.6 seconds from then on, as it does wherever there are no
events. To see which applies on a machine:

```bash
clipsync watch        # prints each clipboard change as it happens
```

Clips from other devices are written to this clipboard as they arrive. The
agent never sends back a clip it just received, and never writes a clip whose
signed copy time is more than ten minutes old, so an old clip cannot be
replayed onto your clipboard as a new copy. After being offline, it puts the
newest clip on the clipboard if it came from another device in the last ten
minutes and is newer than your last local copy.

## Clipboard backends

| System | Reads and writes with |
| --- | --- |
| Linux, Wayland | `wl-paste`, `wl-copy` (package `wl-clipboard`) |
| Linux, X11 | `xclip`, plus its own XFixes client for change events |
| macOS | `pbpaste`, `pbcopy` and `osascript`, which ship with macOS |
| Windows | one long-lived PowerShell helper (Windows PowerShell 5.1) |

If the agent picks the wrong one, set `CLIPSYNC_CLIPBOARD` to `wayland`, `x11`,
`macos` or `windows`. On Windows, `CLIPSYNC_POWERSHELL=pwsh` uses PowerShell 7.

## Updates

A release installed as a service keeps itself current. A minute after it
starts, and then daily, it checks for a newer release, downloads it, checks it
against `SHA256SUMS`, runs it once to confirm it is that release, and restarts
onto it.

```bash
clipsync update       # check now
clipsync --version    # which build this is
```

The agent only ever looks at the GitHub releases it was built from, never at an
address the server gives it, and never moves to an older release. A server that
could name the next binary would own every device. `CLIPSYNC_AUTO_UPDATE=off`
stops the automatic checks.

A server can refuse writes from agents older than a version it names; such an
agent can still read and receive, and updates itself as soon as it is refused.

## From a checkout

To run the agent from the source instead of a release:

```bash
git clone https://github.com/robavelii/clipboard-worker && cd clipboard-worker
npm ci
scripts/install-agent.sh
```

It builds the agent (and the [tray panel](tray.md), when Rust is installed),
puts `clipsync` on your PATH and installs the service, which runs the bundle
straight from the checkout. After a `git pull`, run it again. A build from a
checkout doesn't update itself, and `clipsync status` prints the commit it was
built from.

## Keeping keys out of the config file

The agent keeps the vault key and its device key in
`~/.config/clipsync/config.json`, readable only by you, so it can start
unattended. To keep them off disk instead, set `CLIPSYNC_PASSPHRASE` in the
service's environment: the agent then unlocks the vault key at startup. See
[Security model](security.md#what-is-not-protected).
