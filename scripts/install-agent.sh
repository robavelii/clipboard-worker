#!/usr/bin/env bash
#
# Builds and installs the clipsync agent from this checkout for the current
# user: a launcher on PATH and a service so it starts with the desktop
# session (`clipsync install`: a systemd user service on Linux, a launchd
# agent on macOS), plus, on Linux, the tray app when a Rust toolchain is
# available. A standalone binary from a release needs none of this: it runs
# `clipsync install` itself.
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
AUTOSTART="$CONFIG_DIR/autostart/clipsync-desktop.desktop"
IS_MAC=0
[ "$(uname -s)" = Darwin ] && IS_MAC=1

uninstall() {
  if [ -f "$CLI" ] && command -v node >/dev/null; then
    node "$CLI" uninstall || true
  fi
  if [ "$IS_MAC" = 0 ]; then
    pkill -f "release/clipsync-desktop" 2>/dev/null || true
  fi
  rm -f "$BIN_DIR/clipsync" "$BIN_DIR/clipsync-desktop" "$AUTOSTART"
  echo "Removed the launchers and the tray autostart."
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

if [ "$IS_MAC" = 0 ] && [ "$BUILD_TRAY" = 1 ] && command -v cargo >/dev/null; then
  echo "building  tray app (a few minutes on the first run)"
  (cd "$REPO" && npm run --silent build -w @clipsync/desktop >/dev/null)
fi

# systemd and launchd do not read your shell profile, so a version-manager
# shim on PATH is invisible to them. Resolve the interpreter now.
NODE="$(command -v node)"
if [ -z "$NODE" ]; then
  echo "error: node not found on PATH" >&2
  exit 1
fi

mkdir -p "$BIN_DIR"
ln -sf "$CLI" "$BIN_DIR/clipsync"
echo "launcher  $BIN_DIR/clipsync -> $CLI"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "warning: $BIN_DIR is not on your PATH -- add it to your shell profile" >&2 ;;
esac

# The service runs this node, by its real path, and this checkout's bundle.
"$NODE" "$CLI" install
[ "$IS_MAC" = 1 ] && exit 0

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
echo "Remove everything:  scripts/install-agent.sh --uninstall"
