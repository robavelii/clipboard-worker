---
title: Images and files
description: How screenshots, copied images and files travel between devices, and how to receive files ready to paste.
---

# Images and files

## Images

A copied image, such as a screenshot or a browser's **Copy image**, syncs
through the clipboard like text. Every image up to 25 MB goes to history.
Other computers put it on their clipboard if it is 5 MB or less; larger ones
wait in history for the web app or `clipsync get`.

The agent looks for an image only when the clipboard holds no text, or only the
image's web address (Firefox copies both). `CLIPSYNC_IMAGES=off` turns this off.

## Files

Copying files in a file manager (Nautilus, Dolphin, Finder, Explorer) sends the
files themselves, not their paths: up to 10 at a time, 25 MB each. Images among
them land on other clipboards as above. Folders are skipped.
`CLIPSYNC_FILES=off` turns this off.

From the command line:

```bash
clipsync send report.pdf            # send a file to your devices
clipsync history                    # find its id
clipsync get <clip-id>              # save it here; never overwrites
clipsync get <clip-id> -o ~/Desktop/report.pdf
```

In the web app, attach a file or drop it on the box at the top. On Android,
share it to ClipSync.

## Receiving files, ready to paste

Off by default, because a download nobody asked for is not a paste. Turn it on
for a computer:

```bash
clipsync receive on                         # save into ~/Downloads/ClipSync
clipsync receive on --to ~/Inbox            # or somewhere else
clipsync receive off
```

Files from your other devices are then saved there, and each is put on the
clipboard *as a file*: paste in a file manager (Dolphin, a recent Nautilus,
Finder, Explorer) and the file is there.

- On Linux the folder is your desktop's Downloads folder (`XDG_DOWNLOAD_DIR`),
  then `ClipSync` inside it.
- A file's name is never trusted as a path, and an existing file is never
  replaced. The same file received again is reused; a different one with the
  same name becomes `name (1).ext`.
- The setting lives in the config file, so the background service picks it up.
  `CLIPSYNC_RECEIVE_FILES=on` and `CLIPSYNC_RECEIVE_DIR` do the same from the
  environment.

## How files are stored

Each file is encrypted on the sending device under a random key of its own, in
1 MiB chunks, and uploaded to the server's object storage. The key, the name,
the type, the size and a SHA-256 of the contents travel only inside the clip's
encrypted envelope. The receiving device checks the whole file against that
digest. See [Security model](security.md#images-and-files).

Images and files expire after 7 days unless pinned. Your plan sets how many
bytes of files an account may hold, and whether files other than images sync
at all; see [Plans and limits](limits.md). When an account is at its limit,
its own oldest unpinned files are deleted to make room.
