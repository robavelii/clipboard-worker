#!/usr/bin/env bash
#
# Installs the clipsync agent for the current user: a launcher on PATH and a
# systemd user service so it starts with the desktop session.
#
# Nothing here needs root. Everything lands under $HOME and is undone by
# `scripts/install-agent.sh --uninstall`.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$REPO/apps/agent/dist/clipsync.mjs"
BIN_DIR="${XDG_BIN_HOME:-$HOME/.local/bin}"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="$UNIT_DIR/clipsync.service"

uninstall() {
  systemctl --user disable --now clipsync.service 2>/dev/null || true
  rm -f "$UNIT" "$BIN_DIR/clipsync"
  systemctl --user daemon-reload 2>/dev/null || true
  echo "Removed the launcher and the service. Your credentials in"
  echo "${XDG_CONFIG_HOME:-$HOME/.config}/clipsync are untouched."
  exit 0
}

[ "${1:-}" = "--uninstall" ] && uninstall

if [ ! -f "$CLI" ]; then
  echo "error: $CLI not found -- run 'npm run build' first" >&2
  exit 1
fi

# systemd does not read your shell profile, so a version-manager shim on PATH
# is invisible to it. Resolve the interpreter now and write it in absolutely.
NODE="$(command -v node)"
if [ -z "$NODE" ]; then
  echo "error: node not found on PATH" >&2
  exit 1
fi

mkdir -p "$BIN_DIR" "$UNIT_DIR"
ln -sf "$CLI" "$BIN_DIR/clipsync"
echo "launcher  $BIN_DIR/clipsync -> $CLI"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "warning: $BIN_DIR is not on your PATH -- add it to your shell profile" >&2 ;;
esac

cat > "$UNIT" <<UNITFILE
[Unit]
Description=ClipSync clipboard agent
Documentation=https://github.com/robavelii/clipboard-worker
# The clipboard belongs to the graphical session, so the agent is useless
# without one and should stop when it ends.
After=graphical-session.target
PartOf=graphical-session.target
# Never stop retrying: a laptop that wakes to a dead network should reconnect
# on its own rather than needing a manual restart.
StartLimitIntervalSec=0

[Service]
Type=simple
ExecStart=$NODE $CLI run
Restart=on-failure
RestartSec=5

[Install]
WantedBy=graphical-session.target
UNITFILE
echo "service   $UNIT"

# The service needs to reach the same display the clipboard lives on. These
# are set by the graphical session, not by systemd, so hand them over.
systemctl --user import-environment DISPLAY WAYLAND_DISPLAY XAUTHORITY 2>/dev/null || true

systemctl --user daemon-reload
systemctl --user enable --now clipsync.service

echo
systemctl --user --no-pager --lines=0 status clipsync.service | head -4
echo
echo "Logs:    journalctl --user -u clipsync -f"
echo "Stop:    systemctl --user stop clipsync"
echo "Remove:  scripts/install-agent.sh --uninstall"
