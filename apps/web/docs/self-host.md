---
title: Self-hosting
description: Run your own ClipSync server on any machine, from one binary, Node or Docker. Everything lives in one directory.
---

# Self-hosting

The same server that runs on Cloudflare runs on any machine: a home server, a
NAS, a Raspberry Pi, a VPS. It keeps everything in one directory, a SQLite
database and the encrypted files, and serves the web app too. To run it on
Cloudflare instead, see [Deploy to Cloudflare](cloudflare.md).

## Three ways to run it

**The `clipsync` binary.** The download that runs the agent also runs the
server, web app included:

```bash
clipsync serve --data /var/lib/clipsync
```

**Docker**, for amd64 and arm64, published with each release:

```bash
docker run -d --name clipsync --restart unless-stopped \
  -p 8787:8787 -v clipsync:/data ghcr.io/robavelii/clipsync
docker exec clipsync cat /data/admin-secret
```

It keeps everything in the `/data` volume and runs as an unprivileged user
(uid 1000). A host directory instead of a named volume (`-v /srv/clipsync:/data`)
must be writable by uid 1000. Pass options after the image name, or set them
in the environment. To move off port 8787 inside the container, set
`CLIPSYNC_LISTEN=0.0.0.0:<port>` rather than `--listen`, so the image's health
check follows.

**Node 22 or later**, from a checkout:

```bash
npm ci
npm run build:server
node apps/server/dist/clipsync-server.mjs --data /var/lib/clipsync
```

`apps/server/dist/` is self-contained, so it can be copied to the machine
that runs it.

## Options

| Option | Environment | Default | |
| --- | --- | --- | --- |
| `--data <dir>` | `CLIPSYNC_DATA` | `./clipsync-data` | database and files |
| `--listen <host:port>` | `CLIPSYNC_LISTEN` | `127.0.0.1:8787` | address to bind |
| `--trust-proxy` | `CLIPSYNC_TRUST_PROXY=1` | off | behind a reverse proxy on this machine |
| `--storage <bytes>` | `CLIPSYNC_STORAGE_BYTES` | 5 GiB | most bytes of files to hold |
| `--web <dir>` | | built in | serve another build of the web app |

`clipsync serve --help` lists them. The rest of the server's settings are in
[Configuration](configuration.md#server).

## The first account

On first start the server makes an admin secret and keeps it in
`<data>/admin-secret`, unless `CLIPSYNC_ADMIN_SECRET` is set. The first
account enrols with it:

```bash
clipsync login --url https://clip.example.org
```

## More accounts

The first account comes from the admin secret. After that, either:

- **An admin invite.** Works on any server, with no mail needed. Mint one and
  give it to the person signing up; it works once, for a week:

  ```bash
  curl -s https://clip.example.org/api/signup/invites \
    -H 'content-type: application/json' -d '{"adminSecret":"<admin secret>"}'
  ```

  They run `clipsync signup --url https://clip.example.org --invite SIGNUP-…`,
  or paste it into **Make an account**.

- **Open signup.** `CLIPSYNC_SIGNUP=open` lets anyone sign up with an email
  address. It needs [mail](mail.md). New accounts get the plan in
  `CLIPSYNC_SIGNUP_PLAN`, `free` by default.

## HTTPS

Agents work over plain HTTP. The web app doesn't: anywhere but `localhost`,
browsers keep the cryptography, clipboard and service-worker features it needs
to `https://` pages. Pick one of these.

### 1. A reverse proxy with a certificate

For a VPS, or a home server with a domain and ports 80 and 443 forwarded.
Caddy gets the certificate itself:

```
clip.example.org {
	reverse_proxy 127.0.0.1:8787
}
```

Run the server with `--trust-proxy` behind any proxy on the same machine. With
it, the server takes the client's address and scheme from the proxy's
`X-Forwarded-*` headers. Without it, every request seems to come from
`127.0.0.1`, which the rate limits exempt, and links the server builds say
`http`. The server says so in its log if it sees forwarded requests without the
flag.

> [!WARNING]
> Never pass `--trust-proxy` without a proxy in front: anyone could then claim
> any address and slip past the rate limits.

### 2. `tailscale serve`

With nothing open to the internet:

```bash
clipsync serve --data ~/clipsync-data --trust-proxy
tailscale serve --bg 8787
```

The server is then at `https://<machine>.<tailnet>.ts.net`, with a certificate
Tailscale provides (turn on HTTPS certificates in the tailnet's settings
first). Only devices on your tailnet can reach it, so a phone needs the
Tailscale app too.

### 3. HTTP on the LAN, agents only

```bash
clipsync serve --data ~/clipsync-data --listen 0.0.0.0:8787
clipsync login --url http://192.168.1.20:8787     # on each computer
```

Clips stay encrypted on the wire, as everywhere. But each device's token
travels in the clear, so anyone on the network who captures one can act as
that device: list and delete clips, or revoke devices. They still can't read a
clip. Use it only on a network you trust.

## Running it as a service

On Ubuntu 22.04 or 24.04, `deploy/server/` in the repository sets a machine up
in one go: Node and Caddy (each checked against its release's checksums), the
server as `clipsync-server.service` on `127.0.0.1:8787`, a nightly backup, and
a deploy user whose key can only run the deploy script:

```bash
scp -r deploy/server host:clipsync-setup
ssh host sudo sh clipsync-setup/setup.sh clip.example.org clipsync-setup/deploy-key.pub
```

Run `setup.sh` again at any time; it changes only what is missing. Caddy is the
machine's one proxy: `/etc/caddy/Caddyfile` imports `/etc/caddy/sites/*.caddy`,
and ClipSync owns only `clipsync.caddy`, so other apps can add files of their
own.

### Deploying from CI

The repository's CI deploys every push to `main` that passes to such a machine
(`staging.clip.rfh.et` is one), through the deploy user. It switches back to the
previous build if the new one doesn't answer `/api/health` within 30 seconds.
It needs three repository secrets:

- `STAGING_SSH_KEY`: the private half of the deploy key given to `setup.sh`.
- `STAGING_HOST`: the machine's address.
- `STAGING_KNOWN_HOSTS`: its host key, from `ssh-keyscan -t ed25519 <host>`.

## Backups

Copy the data directory while the server is stopped, or back up online:

```bash
sqlite3 /var/lib/clipsync/clipsync.db ".backup backup.db"     # plus the blobs/ directory
```

`deploy/server/` takes a snapshot to `/var/backups/clipsync/<time>/` at 03:17
UTC and keeps 14 days; set `BACKUP_UPLOAD` in `/etc/clipsync/backup.env` to copy
each off the machine. To restore one: stop `clipsync-server`, delete
`clipsync.db-wal` and `clipsync.db-shm` from the data directory, copy the
snapshot's `clipsync.db` there and unpack its `blobs.tar.gz` in the same place,
`chown -R clipsync:clipsync /var/lib/clipsync`, and start it again.

A backup is ciphertext: it is safe to store anywhere, and useless without your
devices' keys.
