---
title: Development
description: Build, run and test ClipSync from a checkout, and how releases are made.
---

# Development

ClipSync is an npm workspaces monorepo. Run everything from the root, on
Node 22 or later.

```bash
git clone https://github.com/robavelii/clipboard-worker && cd clipboard-worker
npm ci
npm run typecheck
npm test
```

## Running it locally

The local server builds the web app and serves it with the API on port 8787:

```bash
cp apps/worker/.dev.vars.example apps/worker/.dev.vars    # set ADMIN_SECRET
npm run db:migrate:local
npm run dev
```

In a second terminal, enrol this machine and sync:

```bash
npm run build -w @clipsync/agent
node apps/agent/dist/clipsync.mjs login --url http://127.0.0.1:8787
node apps/agent/dist/clipsync.mjs run --verbose
```

Or run the Node server instead of the Worker:

```bash
npm run build:server
CLIPSYNC_ADMIN_SECRET=local-dev-admin-secret node apps/server/dist/clipsync-server.mjs --data ./data
```

`npm run dev:web` runs Vite's dev server for the web app, proxying `/api` to
port 8787.

## Tests

| Command | Runs |
| --- | --- |
| `npm test` | unit tests: crypto, the Worker (in workerd), the agent, the Node server |
| `npm test -w @clipsync/crypto -- test/link.test.ts` | one file |
| `npm test -w @clipsync/crypto -- -t "wrong passphrase"` | one test by name |
| `npm run e2e` | about a hundred end-to-end checks against a running server |

The end-to-end suite stands in for several devices with real cryptography and
WebSockets: enrolment of every kind, live delivery, revocation, re-keying, files,
a second account, and an assertion that no plaintext appears in any API
response. It needs `npm run dev` (or the Node server) running, with
`ADMIN_SECRET` matching `CLIPSYNC_ADMIN_SECRET`, by default
`local-dev-admin-secret`. `CLIPSYNC_URL` points it at another server.

CI runs typecheck, unit tests and the end-to-end suite against the Worker, the
Node server and the Docker image on every pull request.

## Building

| Command | Builds |
| --- | --- |
| `npm run build` | the web app and docs, and the agent bundle `apps/agent/dist/clipsync.mjs` |
| `npm run build:binary` | the standalone `clipsync` for this machine, in `apps/agent/dist/bin/<os>-<arch>/` |
| `npm run build:server` | the Node server, in `apps/server/dist/` |
| `npm run build -w @clipsync/desktop` | the tray app (through the Tauri CLI, not `cargo build`) |
| `docker build -t clipsync .` | the server image |

## These docs

The pages are Markdown in `apps/web/docs/`, listed in order in
`apps/web/docs/nav.json`. `npm run build -w @clipsync/web` renders them to
static pages under `/docs`, and fails on a link to a page or heading that
doesn't exist. Link between pages as `other.md#heading`, so the files read the
same on GitHub.

## Releases

Pushing a `v*` tag builds the five standalone binaries on their own platforms,
runs each one, and publishes them with `SHA256SUMS` to a GitHub Release, then
publishes the Docker image. Pull requests that touch the agent build them too,
without publishing. Every push to `main` that passes CI deploys the Worker.

## Design notes

`docs/decisions.md` records why each part works the way it does: what was
chosen, what the alternatives cost, and the traps worth knowing before you
change it. Read the entry for the area you're touching first.
