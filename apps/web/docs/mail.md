---
title: Mail
description: Outgoing mail for signup codes and notices, over SMTP or Cloudflare Email Service.
---

# Mail

A server sends mail for signup codes, sign-in by email, confirming a deleted
account or a changed address, and notices such as a passphrase reset. Without
mail, open signup answers that it is unavailable and admin invites still work.

## SMTP

Any SMTP server that takes TLS on connect (port 465). `clip.rfh.et` uses OCI
Email Delivery, whose free tier sends 3,000 a month.

| On Cloudflare (`vars`) | On `clipsync serve` | |
| --- | --- | --- |
| `SMTP_HOST` | `CLIPSYNC_SMTP_HOST` | the server's host name |
| `SMTP_PORT` | `CLIPSYNC_SMTP_PORT` | `465` |
| `MAIL_FROM` | `CLIPSYNC_MAIL_FROM` | a bare address, sent as "ClipSync" |
| secret `SMTP_USER` | `CLIPSYNC_SMTP_USER` | |
| secret `SMTP_PASSWORD` | `CLIPSYNC_SMTP_PASSWORD` | |

### OCI Email Delivery

In the OCI console, in the same region as `SMTP_HOST`:

1. **Email Delivery → Approved senders:** add the sending address, for example
   `noreply@clip.example.org`. It must be exactly `MAIL_FROM`.
2. **Email Delivery → Email domains:** add the domain, then publish the SPF and
   DKIM records it shows, so mail isn't marked as spam.
3. **Your user → SMTP credentials:** generate a username and password.
4. Configure the server. On Cloudflare, set `MAIL_FROM` and `SMTP_HOST`
   (`smtp.email.<region>.oci.oraclecloud.com`) in `vars`, then:

   ```bash
   npx wrangler secret put SMTP_USER --config apps/worker/wrangler.jsonc
   npx wrangler secret put SMTP_PASSWORD --config apps/worker/wrangler.jsonc
   ```

The SPF record is a TXT record on the sending domain, for example:

```
v=spf1 include:eu.rp.oracleemaildelivery.com ~all
```

OCI can take a while to see a new record. If the console still says SPF isn't
set up, check the record with `dig TXT clip.example.org` against a public
resolver, then wait.

## Cloudflare Email Service

Instead of SMTP, a Worker can send through Cloudflare. Add a binding to
`wrangler.jsonc`:

```json
"send_email": [{ "name": "EMAIL" }]
```

It then sends from `MAIL_FROM` with no secrets, and takes over from SMTP.
Sending to any address needs the Workers Paid plan and the domain onboarded
under **Email Service → Email Sending**; on the free plan it reaches only your
account's verified addresses. Email Routing, which receives mail, is a
different product and free.
