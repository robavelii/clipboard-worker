#!/bin/sh
#
# Installs the clipsync agent from a GitHub release, on Linux or macOS:
#
#   curl -fsSL https://clip.rfh.et/install.sh | sh
#
# The Worker serves this file with its own address and the releases repo
# filled in (apps/worker/src/routes/install.ts). It downloads the binary for
# this OS and CPU, checks it against the release's SHA256SUMS, links this
# device by QR if it is not enrolled yet, then runs `clipsync install`, which
# copies it to ~/.local/bin and starts it at every login. Re-run it to
# upgrade. Nothing here needs root.
#
#   CLIPSYNC_VERSION=v0.3.0    a release tag instead of the latest
#   CLIPSYNC_LINK=0            install without enrolling; `clipsync link` later
#   CLIPSYNC_DOWNLOAD_BASE=... where to fetch the archives and SHA256SUMS
#                              (a mirror, or a local directory served in tests)
#
# Everything is inside main(), which runs only once the whole script has
# arrived: a download cut short must not run half an installer.

main() {
  set -eu

  url="${CLIPSYNC_URL:-__CLIPSYNC_URL__}"
  repo="__CLIPSYNC_REPO__"
  version="${CLIPSYNC_VERSION:-latest}"

  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) fail "this installer is for Linux and macOS -- on Windows, in PowerShell: irm $url/install.ps1 | iex" ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *) fail "no clipsync build for $(uname -m)" ;;
  esac
  target="$os-$arch"
  archive="clipsync-$target.tar.gz"

  if [ -n "${CLIPSYNC_DOWNLOAD_BASE:-}" ]; then
    base="$CLIPSYNC_DOWNLOAD_BASE"
  elif [ "$version" = latest ]; then
    base="https://github.com/$repo/releases/latest/download"
  else
    base="https://github.com/$repo/releases/download/$version"
  fi

  command -v curl >/dev/null || fail "curl is needed"
  command -v tar >/dev/null || fail "tar is needed"

  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT

  say "downloading  $archive ($version)"
  curl -fsSL "$base/$archive" -o "$tmp/$archive" || fail "could not download $base/$archive"
  curl -fsSL "$base/SHA256SUMS" -o "$tmp/SHA256SUMS" || fail "could not download $base/SHA256SUMS"

  # "<hash>  <name>", or "<hash> *<name>" from a tool in binary mode.
  expected="$(awk -v f="$archive" '{ n = $2; sub(/^\*/, "", n); if (n == f) print $1 }' "$tmp/SHA256SUMS")"
  [ -n "$expected" ] || fail "SHA256SUMS lists no $archive"
  actual="$(sha256 "$tmp/$archive")"
  [ "$actual" = "$expected" ] || fail "checksum mismatch for $archive: expected $expected, got $actual"
  say "verified     sha256 $actual"

  tar -xzf "$tmp/$archive" -C "$tmp"
  bin="$tmp/clipsync"
  say "version      $("$bin" --version)"

  if [ "$os" = linux ] && ! command -v wl-paste >/dev/null && ! command -v xclip >/dev/null; then
    say "note         the agent needs a clipboard tool: sudo apt install wl-clipboard (Wayland) or xclip (X11)"
  fi

  # Enrol from the downloaded copy, before the service exists: `install`
  # then starts it with credentials in place.
  if "$bin" status | grep -q "^Not configured"; then
    if [ "${CLIPSYNC_LINK:-1}" = 0 ]; then
      say "enrol        skipped -- run \`clipsync link --url $url\` when ready"
    else
      say
      say "Link this device: scan the QR below with a device that is already set up."
      say
      "$bin" link --url "$url" </dev/null
    fi
  fi

  say
  "$bin" install </dev/null

  dir="${XDG_BIN_HOME:-$HOME/.local/bin}"
  case ":$PATH:" in
    *":$dir:"*) ;;
    *)
      say
      say "$dir is not on your PATH. Add it, for example:"
      say "  echo 'export PATH=\"$dir:\$PATH\"' >> ~/.profile"
      ;;
  esac
}

say() { printf '%s\n' "$*"; }
fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}
sha256() {
  if command -v sha256sum >/dev/null; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    fail "sha256sum or shasum is needed to check the download"
  fi
}

main "$@"
