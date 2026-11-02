---
title: Configuration
description: Environment variables, files on disk and exit codes, for the agent and the server.
---

# Configuration

## Agent

### Files

| File | Holds |
| --- | --- |
| `~/.config/clipsync/config.json` | the server's address, this device's token, the vault keys, its device key, settings like `receiveFiles`. Mode 0600. |
| `~/.config/clipsync/tray.json` | the tray panel's own device: token, device key, `shortcut` |
| `~/.local/state/clipsync/desktop.log` | the tray panel's debug log |

`XDG_CONFIG_HOME` moves the config directory. That gives one computer a second,
separate enrolment, for a test server say:

```bash
XDG_CONFIG_HOME=~/.config/clipsync-staging clipsync login --url https://staging.example.org
```

### Environment

| Variable | Values | Does |
| --- | --- | --- |
| `CLIPSYNC_PASSPHRASE` | the passphrase | answer passphrase prompts; the agent unlocks the vault from it instead of keeping keys in the config |
| `CLIPSYNC_ADMIN_SECRET` | the server's secret | answer admin-secret prompts |
| `CLIPSYNC_CLIPBOARD` | `wayland`, `x11`, `macos`, `windows` | force a clipboard backend |
| `CLIPSYNC_WATCH` | `off` | poll the clipboard instead of listening for changes |
| `CLIPSYNC_IMAGES` | `off` | don't sync copied images |
| `CLIPSYNC_FILES` | `off` | don't send files copied in a file manager |
| `CLIPSYNC_RECEIVE_FILES` | `on` | save other devices' files here, ready to paste |
| `CLIPSYNC_RECEIVE_DIR` | a directory | where received files go |
| `CLIPSYNC_AUTO_UPDATE` | `off` | stop the daily update check |
| `CLIPSYNC_POWERSHELL` | `pwsh` | Windows: use PowerShell 7 for the clipboard |

For the background service, set these in its environment: a systemd drop-in
(`systemctl --user edit clipsync`), the launchd plist's `EnvironmentVariables`,
or your user environment on Windows.

### Installer

| Variable | Does |
| --- | --- |
| `CLIPSYNC_VERSION` | install this release tag, not the newest |
| `CLIPSYNC_LINK=0` | skip `clipsync link`; enrol later |
| `CLIPSYNC_DOWNLOAD_BASE` | download from a mirror of the release files |

### Exit codes

The service managers depend on these.

| Code | Means | Service manager |
| --- | --- | --- |
| 0 | stopped normally | not restarted |
| 75 | the agent was replaced on disk (an update or a rebuild): restart onto the new one | restarted at once |
| 78 | revoked, re-keyed without a copy for this device, or never enrolled | never restarted |
| other | a failure | restarted after 5 seconds |

Under launchd the agent exits 0 instead of 78: launchd restarts every failure
and can't be told to leave one status alone.

## Server

### `clipsync serve`

| Variable | Option | Default | |
| --- | --- | --- | --- |
| `CLIPSYNC_DATA` | `--data` | `./clipsync-data` | database and files |
| `CLIPSYNC_LISTEN` | `--listen` | `127.0.0.1:8787` | address to bind |
| `CLIPSYNC_TRUST_PROXY=1` | `--trust-proxy` | off | take client address and scheme from `X-Forwarded-*` |
| `CLIPSYNC_STORAGE_BYTES` | `--storage` | 5 GiB | most bytes of files to hold |
| `CLIPSYNC_ADMIN_SECRET` | | `<data>/admin-secret` | the admin secret |
| `CLIPSYNC_SIGNUP` | | off | `open`: anyone with an email address can sign up |
| `CLIPSYNC_SIGNUP_PLAN` | | `free` | the plan new accounts get |
| `CLIPSYNC_SMTP_HOST`, `_PORT`, `_USER`, `_PASSWORD` | | port 465 | outgoing mail over TLS |
| `CLIPSYNC_MAIL_FROM` | | | the sending address |

### Cloudflare

The Worker reads `vars` in `apps/worker/wrangler.jsonc` and secrets set with
`wrangler secret put`. See [Deploy to Cloudflare](cloudflare.md#settings).
