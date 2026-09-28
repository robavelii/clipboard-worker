#!/usr/bin/env bash
#
# Builds and installs the clipsync agent for the current user: a launcher on
# PATH and a systemd user service so it starts with the desktop session, plus
# the tray app when a Rust toolchain is available.
#
# Re-run it after pulling changes: it rebuilds, then restarts whatever is
# running, so nothing is left on the old code.
#
#   --no-tray     skip building the tray app (it takes a few minutes)
#   --uninstall   remove everything this script installed
#
# Nothing here needs root. Everything lands under $HOME.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$REPO/apps/agent/dist/clipsync.mjs"
DESKTOP_BIN="$REPO/apps/desktop/src-tauri/target/release/clipsync-desktop"
BIN_DIR="${XDG_BIN_HOME:-$HOME/.local/bin}"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}"
UNIT_DIR="$CONFIG_DIR/systemd/user"
UNIT="$UNIT_DIR/clipsync.service"
AUTOSTART="$CONFIG_DIR/autostart/clipsync-desktop.desktop"

uninstall() {
  systemctl --user disable --now clipsync.service 2>/dev/null || true
  pkill -f "release/clipsync-desktop" 2>/dev/null || true
  rm -f "$UNIT" "$BIN_DIR/clipsync" "$BIN_DIR/clipsync-desktop" "$AUTOSTART"
  systemctl --user daemon-reload 2>/dev/null || true
  echo "Removed the launchers, the service and the tray autostart."
  echo "Your credentials in $CONFIG_DIR/clipsync are untouched."
  exit 0
}

BUILD_TRAY=1
for arg in "$@"; do
  case "$arg" in
    --uninstall) uninstall ;;
    --no-tray) BUILD_TRAY=0 ;;
    *) echo "error: unknown option $arg" >&2; exit 1 ;;
  esac
done

echo "building  agent"
(cd "$REPO" && npm run --silent build -w @clipsync/agent)

if [ "$BUILD_TRAY" = 1 ] && command -v cargo >/dev/null; then
  echo "building  tray app (a few minutes on the first run)"
  (cd "$REPO" && npm run --silent build -w @clipsync/desktop >/dev/null)
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
# The agent exits 75 when its bundle is rebuilt, to be restarted onto the new
# code. That is a handover, not a failure.
SuccessExitStatus=75
RestartForceExitStatus=75

[Install]
WantedBy=graphical-session.target
UNITFILE
echo "service   $UNIT"

# The service needs to reach the same display the clipboard lives on. These
# are set by the graphical session, not by systemd, so hand them over.
systemctl --user import-environment DISPLAY WAYLAND_DISPLAY XAUTHORITY 2>/dev/null || true

systemctl --user daemon-reload
systemctl --user enable clipsync.service
# restart, not start: an agent that is already running would otherwise keep
# the code it was started with.
systemctl --user restart clipsync.service

# The tray app is optional: it needs a Rust toolchain to build, and the agent
# is fully usable without it.
if [ -x "$DESKTOP_BIN" ]; then
  ln -sf "$DESKTOP_BIN" "$BIN_DIR/clipsync-desktop"
  echo "tray      $BIN_DIR/clipsync-desktop"

  mkdir -p "$(dirname "$AUTOSTART")"
  cat > "$AUTOSTART" <<DESKTOPFILE
[Desktop Entry]
Type=Application
Name=ClipSync
Comment=Encrypted clipboard history in the tray
Exec=$DESKTOP_BIN
Icon=$REPO/apps/desktop/src-tauri/icons/icon.png
Terminal=false
Categories=Utility;
X-GNOME-Autostart-enabled=true
DESKTOPFILE
  echo "autostart $AUTOSTART"

  # Relaunch onto the new build. Killing first matters: launching the app
  # while it runs only toggles the existing panel.
  if [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
    pkill -f "$DESKTOP_BIN" 2>/dev/null || true
    sleep 1
    setsid -f "$DESKTOP_BIN" >/dev/null 2>&1
    echo "tray      restarted"
  fi
else
  echo "tray      not built — run 'npm run build -w @clipsync/desktop' for the tray app"
fi

echo
systemctl --user --no-pager --lines=0 status clipsync.service | head -4
echo
echo "Logs:    journalctl --user -u clipsync -f"
echo "Stop:    systemctl --user stop clipsync"
echo "Remove:  scripts/install-agent.sh --uninstall"
