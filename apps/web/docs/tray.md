---
title: Tray panel
description: A searchable history one shortcut away, on Linux.
---

# Tray panel

`clipsync-desktop` is a tray icon with a searchable history: click a clip to
copy it, pin it or delete it. It runs on Linux and is built from a checkout of
the repository (below).

## Opening it

Press <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>V</kbd> anywhere. The panel opens at the
pointer with the newest clip highlighted.

| Key | Does |
| --- | --- |
| type | search |
| <kbd>↑</kbd> <kbd>↓</kbd> | move |
| <kbd>Enter</kbd> | copy and close |
| <kbd>Esc</kbd> | close |

The tray menu's **Open ClipSync** works too. On Ubuntu a left click on a tray
icon does nothing; use the menu.

The shortcut is deliberately not <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>V</kbd>,
which pastes in every Linux terminal. To change it, add a line to
`~/.config/clipsync/tray.json` and restart the panel:

```json
"shortcut": "Super+Shift+V"
```

Running `clipsync-desktop` while it is already running toggles the panel. On
Wayland, where apps cannot grab global shortcuts, bind that command to a key in
your desktop's keyboard settings.

## Setup

It needs no setup beyond enrolling the agent. On first run it takes the vault
keys from the agent's config and enrols itself as a second device, named after
this one with `(tray)` added, keeping its own token and device key in
`~/.config/clipsync/tray.json`.

It is a separate device so that clips copied on this machine appear in it live:
a device is never sent its own copies. Revoking it from another device stops
the panel; delete `tray.json` and reopen it to enrol again. After a re-key it
fetches its own copy of the new key, whether or not the agent is running.

## Building it

```bash
git clone https://github.com/robavelii/clipboard-worker && cd clipboard-worker
npm ci
scripts/install-agent.sh
```

`scripts/install-agent.sh` builds the agent and, when a Rust toolchain is
installed, the tray app; puts `clipsync` and `clipsync-desktop` on your PATH;
installs the agent's service and a tray autostart entry. Re-run it after
pulling changes. `--no-tray` skips the tray build, `--uninstall` reverses
everything. It needs no root.

Its debug log is `~/.local/state/clipsync/desktop.log`.
