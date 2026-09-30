/**
 * The page's own clipboard: sending what is on it, and copying clips onto it.
 *
 * Browsers allow both only inside a tap, and iOS Safari requires the call
 * itself to be made in the tap, before anything is awaited. So a copy hands
 * the browser a promise of the bytes rather than the bytes.
 */

import type { ApiClient } from "@clipsync/client";
import { uploadFile } from "@clipsync/client/files";
import { sealText, type RingKeys } from "@clipsync/client/ring";
import type { DecryptedClip } from "@clipsync/react";
import { fetchFile } from "./FileView";

/** What a tap on "Paste" found on the clipboard. */
export type Pasted = { text: string } | { file: File };

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/**
 * Read the clipboard: an image if there is one, else its text. Null when it
 * holds neither. Throws the browser's NotAllowedError when the read is
 * refused (outside a tap, the permission denied, iOS's Paste bubble
 * dismissed).
 */
export async function readClipboard(): Promise<Pasted | null> {
  const clipboard = navigator.clipboard;
  if (typeof clipboard.read !== "function") {
    const text = await clipboard.readText();
    return text.trim() ? { text } : null;
  }
  const items = await clipboard.read();
  for (const item of items) {
    const type = item.types.find((t) => t.startsWith("image/"));
    if (type) {
      const blob = await item.getType(type);
      const name = `pasted-image.${EXTENSIONS[type] ?? "png"}`;
      return { file: new File([blob], name, { type }) };
    }
  }
  for (const item of items) {
    if (item.types.includes("text/plain")) {
      const text = await (await item.getType("text/plain")).text();
      if (text.trim()) return { text };
    }
  }
  return null;
}

export function canReadClipboard(): boolean {
  return (
    typeof navigator !== "undefined" &&
    Boolean(navigator.clipboard) &&
    (typeof navigator.clipboard.read === "function" ||
      typeof navigator.clipboard.readText === "function")
  );
}

/** A phone or tablet, where no agent watches the clipboard for you. */
export function isTouchFirst(): boolean {
  return typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
}

export async function sendText(
  api: ApiClient,
  keys: RingKeys,
  account: string,
  deviceId: string,
  text: string,
): Promise<void> {
  await api.createClip(await sealText(keys, account, deviceId, text));
}

export async function sendFile(
  api: ApiClient,
  keys: RingKeys,
  account: string,
  deviceId: string,
  file: File,
  onProgress?: (sentBytes: number, totalBytes: number) => void,
): Promise<void> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  await uploadFile(
    api,
    keys,
    account,
    deviceId,
    { name: file.name || "pasted-image", mime: file.type, bytes },
    (sent) => onProgress?.(sent, bytes.length),
  );
}

/** Whether {@link copyClip} can put this clip on the clipboard. */
export function canCopy(clip: DecryptedClip): boolean {
  if (clip.file) return clip.type === "image" && typeof ClipboardItem === "function";
  return clip.text !== null;
}

/** Copy a text or image clip. Call it straight from the tap. */
export function copyClip(
  api: ApiClient,
  keys: RingKeys,
  account: string,
  clip: DecryptedClip,
): Promise<void> {
  if (clip.file) return copyImage(fetchFile(api, keys, account, clip).then((f) => f.blob));
  if (clip.text === null) return Promise.reject(new Error("that clip cannot be read here"));
  return navigator.clipboard.writeText(clip.text);
}

/**
 * Copy an image clip. Browsers take PNG on the clipboard (Chrome takes
 * nothing else), so other formats are converted first. `image` is a promise
 * so the write can start inside the tap, while the file is still being
 * fetched and decrypted.
 */
export async function copyImage(image: Promise<Blob>): Promise<void> {
  const png = image.then((blob) => (blob.type === "image/png" ? blob : toPng(blob)));
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

async function toPng(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (png) => (png ? resolve(png) : reject(new Error("could not convert the image"))),
        "image/png",
      ),
    );
  } finally {
    bitmap.close();
  }
}
