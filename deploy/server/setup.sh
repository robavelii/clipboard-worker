#!/bin/sh
#
# Prepares an Ubuntu server (22.04 or 24.04, x64 or arm64) to run the ClipSync
# Node server (apps/server) behind the machine's shared Caddy. Idempotent: run it again after
# changing the domain, or to repair a half-finished setup.
#
#   sudo sh setup.sh <domain> [<deploy public key file>]
#
#   <domain>             the hostname Caddy gets a certificate for; its DNS
#                        A record must already point at this machine
#   <deploy public key>  the key CI deploys with (decisions §39); it may only
#                        run clipsync-deploy, nothing else
#
# What it sets up:
#   /opt/node                    Node 22, from nodejs.org, checksum-verified
#   /opt/clipsync/releases/      one directory per deployed build
#   /opt/clipsync/current        symlink to the live one
#   /var/lib/clipsync            the database, files and admin secret (0700)
#   /var/backups/clipsync        nightly snapshots, 14 kept
#   clipsync-server.service      the server, as the `clipsync` user, on 127.0.0.1:8787
#   clipsync-backup.timer        the nightly snapshot
#   Caddy                        the one proxy for every app on the machine:
#                                /etc/caddy/Caddyfile imports /etc/caddy/sites/*.caddy,
#                                and ClipSync's site is sites/clipsync.caddy
#   iptables                     80 and 443 opened (Oracle's Ubuntu images reject them)
#
# If another proxy already holds 80 or 443, Caddy is installed and configured
# but not started: move that app's site into /etc/caddy/sites/, stop its
# proxy, and start Caddy (decisions §39).
#
# Nothing is deployed here: the first release arrives with clipsync-deploy.

set -eu

NODE_VERSION=v22.22.0
HERE=$(cd "$(dirname "$0")" && pwd)

main() {
  [ "$(id -u)" = 0 ] || die "run as root (sudo sh setup.sh ...)"
  [ $# -ge 1 ] || die "usage: sudo sh setup.sh <domain> [<deploy public key file>]"
  domain=$1
  deploy_key=${2:-}

  step "packages"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q
  apt-get install -y -q curl ca-certificates gnupg sqlite3 iptables-persistent >/dev/null
  # Caddy's own repository: Ubuntu 22.04 does not package it.
  if [ ! -f /etc/apt/sources.list.d/caddy-stable.list ]; then
    curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
      | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
      > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -q
  fi
  apt-get install -y -q caddy >/dev/null

  install_node
  create_users "$deploy_key"
  install_files "$domain"
  open_firewall

  step "services"
  systemctl daemon-reload
  systemctl enable clipsync-server.service clipsync-backup.timer >/dev/null
  systemctl start clipsync-backup.timer
  start_caddy
  if [ -e /opt/clipsync/current/clipsync-server.mjs ]; then
    systemctl restart clipsync-server.service
  else
    echo "no release deployed yet: the server starts with the first clipsync-deploy"
  fi

  step "done"
  echo "https://$domain will answer once a release is deployed and DNS points here."
  echo "The admin secret (to enrol the first device) appears in /var/lib/clipsync/admin-secret on first start."
}

step() { printf '\n== %s\n' "$1"; }
die() { echo "setup.sh: $*" >&2; exit 1; }

install_node() {
  step "node $NODE_VERSION"
  if [ -x /opt/node/bin/node ] && [ "$(/opt/node/bin/node --version)" = "$NODE_VERSION" ]; then
    echo "already installed"
    return
  fi
  case "$(uname -m)" in
    x86_64) arch=x64 ;;
    aarch64) arch=arm64 ;;
    *) die "unsupported CPU $(uname -m)" ;;
  esac
  name="node-$NODE_VERSION-linux-$arch"
  tmp=$(mktemp -d)
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/$name.tar.xz" -o "$tmp/$name.tar.xz"
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  (cd "$tmp" && grep " $name.tar.xz\$" SHASUMS256.txt | sha256sum -c -) || die "node download failed its checksum"
  rm -rf /opt/node.new
  mkdir -p /opt/node.new
  tar -xJf "$tmp/$name.tar.xz" -C /opt/node.new --strip-components=1
  rm -rf /opt/node
  mv /opt/node.new /opt/node
  rm -rf "$tmp"
  /opt/node/bin/node --version
}

create_users() {
  step "users"
  # Runs the server. No shell, no home, owns only its data.
  id clipsync >/dev/null 2>&1 || useradd --system --user-group --no-create-home --shell /usr/sbin/nologin clipsync
  install -d -o clipsync -g clipsync -m 0700 /var/lib/clipsync
  install -d -o root -g root -m 0755 /opt/clipsync /opt/clipsync/releases
  install -d -o root -g root -m 0700 /var/backups/clipsync

  # CI logs in as this user to upload a release and run clipsync-deploy,
  # which is all sudo lets it do.
  id clipsync-deploy >/dev/null 2>&1 || useradd --create-home --shell /bin/sh clipsync-deploy
  if [ -n "$1" ]; then
    [ -f "$1" ] || die "no such public key file: $1"
    install -d -o clipsync-deploy -g clipsync-deploy -m 0700 /home/clipsync-deploy/.ssh
    install -o clipsync-deploy -g clipsync-deploy -m 0600 "$1" /home/clipsync-deploy/.ssh/authorized_keys
    echo "deploy key installed for clipsync-deploy"
  fi
  echo 'clipsync-deploy ALL=(root) NOPASSWD: /usr/local/sbin/clipsync-deploy' > /etc/sudoers.d/clipsync-deploy
  chmod 0440 /etc/sudoers.d/clipsync-deploy
  visudo -cf /etc/sudoers.d/clipsync-deploy >/dev/null
}

install_files() {
  step "files"
  install -m 0755 "$HERE/clipsync-deploy" /usr/local/sbin/clipsync-deploy
  install -m 0755 "$HERE/clipsync-backup" /usr/local/sbin/clipsync-backup
  install -m 0644 "$HERE/clipsync-server.service" /etc/systemd/system/clipsync-server.service
  install -m 0644 "$HERE/clipsync-backup.service" /etc/systemd/system/clipsync-backup.service
  install -m 0644 "$HERE/clipsync-backup.timer" /etc/systemd/system/clipsync-backup.timer
  install -d -m 0755 /etc/clipsync
  [ -e /etc/clipsync/server.env ] || install -m 0644 "$HERE/server.env" /etc/clipsync/server.env
  install_caddy_config "$1"
}

# The Caddyfile is the machine's, not ClipSync's: it is written only when
# there is none or it is still the package's default page, and other apps'
# files in sites/ are never touched.
install_caddy_config() {
  install -d -m 0755 /etc/caddy/sites
  sed "s/__DOMAIN__/$1/g" "$HERE/clipsync.caddy" > /etc/caddy/sites/clipsync.caddy
  if ! grep -qF 'import /etc/caddy/sites/*.caddy' /etc/caddy/Caddyfile 2>/dev/null; then
    if [ ! -e /etc/caddy/Caddyfile ] || grep -q '/usr/share/caddy' /etc/caddy/Caddyfile; then
      install -m 0644 "$HERE/Caddyfile" /etc/caddy/Caddyfile
    else
      die "/etc/caddy/Caddyfile is not the default: add 'import /etc/caddy/sites/*.caddy' to it, then run setup.sh again"
    fi
  fi
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
  # validate runs as root and may create the log file; Caddy runs as caddy.
  chown -R caddy:caddy /var/log/caddy
}

# Starts or reloads Caddy, unless another process holds 80 or 443. Replacing
# another app's proxy is a step for whoever runs the machine, so Caddy is
# then left disabled: enabled, it would race that proxy for the ports at boot.
start_caddy() {
  step "caddy"
  for port in 80 443; do
    holder=$(ss -ltnpH "sport = :$port" | sed -n 's/.*users:(("\([^"]*\)".*/\1/p' | head -n 1)
    if [ -n "$holder" ] && [ "$holder" != caddy ]; then
      systemctl disable --now caddy >/dev/null 2>&1 || true
      echo "port $port is held by $holder, so Caddy is installed but not started."
      echo "Put that app's site in /etc/caddy/sites/, stop its proxy, then: systemctl enable --now caddy"
      return
    fi
  done
  systemctl enable caddy >/dev/null
  systemctl reload-or-restart caddy
}

# Oracle's Ubuntu images ship iptables rules that reject everything but SSH,
# in addition to the cloud security list. Both must allow 80 and 443.
open_firewall() {
  step "firewall"
  # Deleted and inserted again rather than checked with -C: the images end
  # INPUT with a REJECT, and an ACCEPT appended after it exists but never
  # matches. Ports Docker publishes skip INPUT, so they work either way.
  for port in 80 443; do
    while iptables -D INPUT -p tcp --dport "$port" -m conntrack --ctstate NEW -j ACCEPT 2>/dev/null; do :; done
    iptables -I INPUT -p tcp --dport "$port" -m conntrack --ctstate NEW -j ACCEPT
    echo "opened $port"
  done
  netfilter-persistent save >/dev/null 2>&1 || true
  echo "also allow TCP 80 and 443 in the instance's security list or network security group"
}

main "$@"
