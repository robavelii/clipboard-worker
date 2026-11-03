---
title: Plans and limits
description: How long clips live, how big they can be, and what each plan allows.
---

# Plans and limits

## Retention

| Clip | Kept for | Unless |
| --- | --- | --- |
| Text | 30 days | pinned |
| Images and files | 7 days | pinned |

An hourly job deletes expired clips everywhere, files included. Clipboard
history collects tokens and passwords whether you intend it to or not, so the
default is to forget.

Identical content is stored once. Copying something you copied last week moves
that clip back to the top instead of adding a second one, so history does not fill
with duplicates.

## Sizes

| | Limit |
| --- | --- |
| A text clip | 256 KiB of ciphertext |
| An image or file | 25 MB |
| An image applied to another clipboard | 5 MB (bigger ones wait in history) |
| Files in one copy | 10 |

## Plans

Each account has a plan. The hosted service gives new accounts **free**, a
trial you can keep: one computer and one phone, with a short memory. **Pro**
is the paid plan.

| | Free | Pro | Unlimited |
| --- | --- | --- | --- |
| Devices | 2 | 10 | no limit |
| Text kept for | 3 days | 90 days | 30 days |
| Images and files kept for | 1 day | 30 days | 7 days |
| Files other than images | no | yes | yes |
| Pinned clips | 10 | no limit | no limit |
| File storage held | 10 MB | 2 GB | the server's limit |
| Uploads a month | 500 | 20,000 | the server's limit |
| Downloads a month | 5,000 | 200,000 | the server's limit |

`unlimited` is what accounts made before plans existed keep, and what a
self-hosted server's first account gets.

A clip keeps the expiry it was written with: moving to another plan changes
how long new clips live, not old ones. Pinned clips never expire, which is
why a plan with short history also caps how many can be pinned; unpin one to
pin another. A device past the plan's limit keeps working, but no new one can
join until one is removed.

**Settings → Plan** in the web app shows yours, with how much of each you have
used this month. `clipsync status` shows the server's budgets.

When an account is at its storage limit, its own oldest unpinned files are
deleted to make room for a new one. One account's upload never removes another
account's files. A new file is refused only when there is nothing of yours left
to delete.

## The server's budget

On Cloudflare the server holds files in R2, which has no spending cap of its
own. So the server counts every billed operation before making it and stays
inside a budget it is given, half R2's free tier by default:

| | Free tier | Budget | Past it |
| --- | --- | --- | --- |
| Storage | 10 GB-month | 5 GB held at any moment | the uploader's oldest unpinned files make room |
| Uploads | 1 million a month | 500,000 a month | refused until the 1st |
| Downloads | 10 million a month | 5 million a month | refused until the 1st |

A self-hosted server on disk has only the storage limit (`--storage`). See
[Configuration](configuration.md#server).
