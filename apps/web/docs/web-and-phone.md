---
title: Web app and phone
description: The history in a browser, keyboard shortcuts, and every way to send from and receive on a phone.
---

# Web app and phone

The web app is served from the same address as the server, `https://clip.rfh.et`
for the hosted service. It works in any modern browser, and installs on a phone
as an app.

## Unlocking

A browser stays one of your devices until you sign it out, but it holds the
vault key only for as long as the tab is open. Closing the tab, or **Lock**,
forgets the key; the passphrase opens it again. That holds for a browser that
joined by QR too: it never learned the passphrase, but it is still the
account's.

On a phone, **Settings → Security → Keep unlocked** keeps the key in the
browser's storage, so the share sheet works without the passphrase. The trade:
anyone who can open that browser can read your clipboard.

## The history

The history lists every clip, newest first and pins on top, beside the clip
you have open. Each clip shows which device copied it, when, and when it will
expire.

- **Search** filters as you type. It runs in the browser, on decrypted clips:
  the server has nothing it could search.
- **Filters** narrow the list to pinned clips, images and files, or what this
  device copied.
- **Pin** a clip to keep it. Pinned clips never expire; the free plan keeps up to 10.
- **Delete** removes it everywhere; **Undo** brings it back for six seconds.
- **Open link** opens a clip that is a single link in a new tab. Links inside
  longer clips are clickable too. Only `http` and `https` links are: a copied
  `javascript:` address stays text.

To send from the web app, type or paste into the box at the top, attach a
file, or drop one on it.

## Keyboard shortcuts

Shortcuts work anywhere on the page except inside a text field.

| Key | Does |
| --- | --- |
| <kbd>/</kbd> | search |
| <kbd>j</kbd> or <kbd>↓</kbd> | next clip |
| <kbd>k</kbd> or <kbd>↑</kbd> | previous clip |
| <kbd>Enter</kbd> or <kbd>c</kbd> | copy the open clip |
| <kbd>o</kbd> | open the open clip's link |
| <kbd>p</kbd> | pin or unpin |
| <kbd>Delete</kbd> or <kbd>Backspace</kbd> | delete |
| <kbd>z</kbd> | undo the last delete |
| <kbd>Esc</kbd> | leave the search box |

## On a phone

No browser lets a page read the clipboard on its own, so on a phone receiving
is a tap and sending is a deliberate act. `/phone` on your server walks through
the setup for your phone.

### Receiving

The newest clip from another device sits in a card at the top. **Copy** puts
it on the phone's clipboard, images included. Other files can be downloaded.

### Sending

- **Share → ClipSync** (Android, once installed): text, links, photos and
  files from any app. What you share is kept on the phone and encrypted there;
  it never reaches the network in the clear.
- **Paste to ClipSync**: come back to the app after copying something, and a
  bar at the bottom sends what is on the clipboard, text or an image, in one
  tap. iOS asks you to confirm each paste.
- **Attach** a photo or file from the box at the top.
- **A Shortcut** (iPhone and iPad), run from Back Tap or the Action Button,
  sends the clipboard's text. `/phone` shows how to build it.

### Installing

- **Android**, in Chrome: menu → **Add to Home screen** or **Install app**.
- **iPhone and iPad**, in Safari: **Share → Add to Home Screen**.

> [!NOTE]
> On iOS the Shortcut opens Safari, which keeps its storage apart from the
> Home Screen app. Pair ClipSync in Safari too, and unlock it there once.

## Settings

**Settings** (in the menu) holds everything about the account:

| Section | What's there |
| --- | --- |
| Devices | list, rename, revoke, then re-key |
| Security | change the passphrase, the recovery key, keep unlocked, re-key |
| Account | email address, export everything, delete the account |
| Plan | your limits and how much of each you've used |

Each runs the same code the CLI does.

## Over plain HTTP

Browsers allow the cryptography, clipboard and service-worker features the app
needs only on `https://` pages (and `localhost`). A self-hosted server needs
HTTPS for the web app; agents work over plain HTTP. See
[Self-hosting](self-host.md#https).
