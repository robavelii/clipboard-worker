---
title: Deploy to Cloudflare
description: Run ClipSync on your own Cloudflare account, on Workers, D1, Durable Objects and R2.
---

# Deploy to Cloudflare

This is how `clip.rfh.et` runs: a Worker for the API and web app, a D1 database
for ciphertext history, a Durable Object per account for live sync, and an R2
bucket for encrypted files. It fits Cloudflare's free tiers for personal use.

## Set up

From a checkout of the repository:

```bash
npm ci
npx wrangler login
```

Create the database, and paste the `database_id` it prints into
`apps/worker/wrangler.jsonc`:

```bash
npm run db:create
npm run db:migrate
```

Create the bucket for files. Its name must match `r2_buckets` in
`wrangler.jsonc`:

```bash
npx wrangler r2 bucket create clipsync-blobs
```

Set the admin secret, which enrols the very first device:

```bash
npx wrangler secret put ADMIN_SECRET --config apps/worker/wrangler.jsonc
```

Point it at your hostname: change the `routes` entry in `wrangler.jsonc` to
your own domain on Cloudflare. It binds a custom domain and sets
`workers_dev: false`, so there is one public address, not two. Set
`workers_dev: true` to use the generated `*.workers.dev` address instead.

Then deploy:

```bash
npm run deploy
```

Enrol the first device with `clipsync login --url https://<your host>`.

## Settings

Everything else is in `vars` in `wrangler.jsonc`:

| Variable | Default | |
| --- | --- | --- |
| `SIGNUP` | `open` | `open`: anyone with an email address; `off`: invites only |
| `SIGNUP_PLAN` | `free` | the plan new accounts get |
| `MAIL_FROM`, `SMTP_HOST`, `SMTP_PORT` | | outgoing mail; see [Mail](mail.md) |
| `RELEASES_REPO` | `robavelii/clipboard-worker` | whose GitHub releases `/install.sh` downloads |
| `MIN_AGENT_VERSION` | `v0.0.0` | refuse writes from agent releases older than this |
| `R2_STORAGE_BUDGET_BYTES` | 5 GiB | bytes of files held at once |
| `R2_CLASS_A_BUDGET` | 500,000 | R2 writes a month |
| `R2_CLASS_B_BUDGET` | 5,000,000 | R2 reads a month |

Secrets, set with `npx wrangler secret put <name> --config apps/worker/wrangler.jsonc`:

| Secret | |
| --- | --- |
| `ADMIN_SECRET` | enrols the first device, mints invites |
| `SMTP_USER`, `SMTP_PASSWORD` | mail credentials |

## Deploying from CI

The repository's CI deploys every push to `main` that passes its checks: it
applies new migrations to the production database, deploys the Worker, then
checks that it answers. It needs two repository secrets (**Settings → Secrets
and variables → Actions**):

- `CLOUDFLARE_API_TOKEN`: a token from the **Edit Cloudflare Workers** template,
  plus **Account → D1 → Edit** for migrations and **Zone → Workers Routes →
  Edit** for the custom domain. Scope it to your account and the Worker's zone.
- `CLOUDFLARE_ACCOUNT_ID`: from the dashboard's Workers & Pages sidebar, or
  `npx wrangler whoami`.

Deploys on `main` queue rather than cancel each other, so one is never cut off
between its migration and the deploy itself.

> [!IMPORTANT]
> Migrations run while the old Worker is still live, so a migration must only
> add: new tables, new columns that are nullable or have a default. A migration
> that breaks the running Worker leaves it broken until the deploy finishes.

## Plans

Each account's limits come from a row in the `plans` table, so changing them
needs no deploy:

```bash
npx wrangler d1 execute clipsync --remote \
  --command "UPDATE users SET plan = 'unlimited' WHERE id = '<account id>'"
```

See [Plans and limits](limits.md) for what each plan allows.
