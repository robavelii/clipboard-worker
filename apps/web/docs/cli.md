---
title: CLI reference
description: Every clipsync command and its options.
---

# CLI reference

`clipsync` with no arguments, or `clipsync --help`, prints this list. Most
commands act on the account this computer is enrolled in; the ones that enrol
take `--url`, the server's address.

## Joining an account

| Command | Does |
| --- | --- |
| `clipsync link --url <url> [--name <device>]` | join by QR or link, approved from a device you already use |
| `clipsync signin --url <url> [--email <address>]` | join with the account's email and passphrase |
| `clipsync signup --url <url> [--invite <code>]` | make a new account, with a mailed code or an invite |
| `clipsync pair <code> --url <url> [--name <device>]` | join with a pairing code, then the passphrase |
| `clipsync login --url <url> [--name <device>]` | enrol with the server's admin secret: its first account |

## Adding other devices

| Command | Does |
| --- | --- |
| `clipsync invite` | show a QR for a phone or browser to scan |
| `clipsync approve <link-url>` | approve a computer that ran `clipsync link` |
| `clipsync pair-code` | mint a pairing code, valid 10 minutes, once |

## Syncing

| Command | Does |
| --- | --- |
| `clipsync run [--push-current] [--verbose]` | watch the clipboard and sync, in the foreground |
| `clipsync install [--dry-run]` | run the agent in the background at every login |
| `clipsync uninstall` | stop and remove that service |
| `clipsync status` | account, server, clipboard backend, service, budgets |
| `clipsync watch` | print each clipboard change as it happens |
| `clipsync update` | update to the newest release now |
| `clipsync --version` | which build this is |

`install --dry-run` prints the service definition it would write.

## Clips

| Command | Does |
| --- | --- |
| `clipsync history [-n <count>] [--full]` | recent clips, decrypted here; `--full` doesn't truncate |
| `clipsync copy <clip-id>` | put an old clip back on this clipboard |
| `clipsync send <file>` | send an image or file to your devices |
| `clipsync get <clip-id> [-o <path>]` | save an image or file clip; never overwrites |
| `clipsync receive [on\|off] [--to <dir>]` | save other devices' files here, ready to paste |

## Devices

| Command | Does |
| --- | --- |
| `clipsync devices` | list devices |
| `clipsync devices --rename <id> <name>` | rename one |
| `clipsync devices --revoke <id> [--rekey]` | revoke one; `--rekey` re-keys straight after |
| `clipsync logout` | revoke this computer, then forget its credentials |

## Keys and recovery

| Command | Does |
| --- | --- |
| `clipsync passphrase` | change the passphrase |
| `clipsync passphrase --reset` | forgot it: reset with the server's admin secret, from this device |
| `clipsync recovery [new\|off]` | show, make or replace, or remove the recovery key |
| `clipsync recover --url <url> [--revoke-others]` | forgot the passphrase: reset it with the recovery key |
| `clipsync rekey [--finish]` | move every device to a new vault key; `--finish` resumes |

## Account

| Command | Does |
| --- | --- |
| `clipsync email <address>` | give the account an email address, or change it |
| `clipsync export <dir> [--ciphertext]` | save every clip and file, decrypted here |
| `clipsync delete-account [--by-email]` | delete the account and everything in it |

## Server

| Command | Does |
| --- | --- |
| `clipsync serve [--data <dir>] [--listen <host:port>]` | run a ClipSync server here; `serve --help` for the rest |

See [Self-hosting](self-host.md).

## Prompts and scripts

Commands that need a secret ask for it on the terminal. To run them without
one, set it in the environment: `CLIPSYNC_PASSPHRASE` for the passphrase,
`CLIPSYNC_ADMIN_SECRET` for the admin secret.

> [!TIP]
> In zsh and bash, `<id>` and `<url>` in these tables are placeholders. Type the
> value itself, without the angle brackets: the shell reads `<` as a redirect.
