/**
 * Images and files: encrypted in chunks under a key of their own, uploaded
 * to the Worker's R2 bucket, and adopted by a clip whose v2 envelope holds
 * that key. Shared by the web UI and the CLI.
 */

import {
  generateBlobKey,
  importBlobKey,
  openChunk,
  sealChunk,
  sha256Hex,
} from "@clipsync/crypto";
import {
  BLOB_CHUNK_BYTES,
  BLOB_CHUNK_OVERHEAD,
  MAX_FILE_BYTES,
  type Clip,
  type CreateClipResponse,
} from "@clipsync/protocol";
import type { ApiClient } from "./index";
import { readClip, sealFile, type FileMeta, type RingKeys } from "./ring";

export interface LocalFile {
  name: string;
  /** MIME type; "application/octet-stream" when unknown. */
  mime: string;
  bytes: Uint8Array;
}

/** Images get shown inline; everything else is a file to save. */
export function clipTypeFor(mime: string): "image" | "file" {
  return /^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(mime) ? "image" : "file";
}

export class FileTooLargeError extends Error {
  constructor(readonly size: number) {
    super(`files are limited to ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB`);
  }
}

/**
 * Encrypt and upload a file, then store the clip that adopts it.
 *
 * If anything fails before the clip is written, the half-uploaded blob is
 * deleted (best effort; the Worker sweeps abandoned uploads after an hour
 * regardless).
 */
export async function uploadFile(
  api: ApiClient,
  keys: RingKeys,
  account: string,
  device: string,
  file: LocalFile,
  onProgress?: (sentBytes: number) => void,
): Promise<CreateClipResponse> {
  const size = file.bytes.length;
  if (size === 0) throw new Error("that file is empty");
  if (size > MAX_FILE_BYTES) throw new FileTooLargeError(size);

  const chunks = Math.ceil(size / BLOB_CHUNK_BYTES);
  const blobKey = generateBlobKey();
  const aes = await importBlobKey(blobKey);
  const { id: blobId } = await api.createBlob({
    chunks,
    bytes: size + chunks * BLOB_CHUNK_OVERHEAD,
    type: clipTypeFor(file.mime || "application/octet-stream"),
  });

  try {
    for (let i = 0; i < chunks; i++) {
      const part = file.bytes.subarray(i * BLOB_CHUNK_BYTES, (i + 1) * BLOB_CHUNK_BYTES);
      await api.putBlobChunk(blobId, i, await sealChunk(aes, blobId, i, chunks, part));
      onProgress?.(Math.min(size, (i + 1) * BLOB_CHUNK_BYTES));
    }
    const meta: FileMeta = {
      name: file.name,
      mime: file.mime || "application/octet-stream",
      size,
      sha256: await sha256Hex(file.bytes),
      key: blobKey,
      blobId,
      chunks,
    };
    return await api.createClip(
      await sealFile(keys, account, device, clipTypeFor(meta.mime), meta),
    );
  } catch (err) {
    await api.deleteBlob(blobId).catch(() => undefined);
    throw err;
  }
}

/**
 * Download and decrypt an image or file clip, checking every chunk's place
 * and the whole file's digest against what its envelope vouches for.
 */
export async function downloadFile(
  api: ApiClient,
  keys: RingKeys,
  clip: Clip,
  account: string,
  onProgress?: (receivedBytes: number) => void,
): Promise<{ meta: FileMeta; bytes: Uint8Array }> {
  const { file: meta } = await readClip(keys, clip, account);
  if (!meta) throw new Error("that clip is text, not a file");

  const aes = await importBlobKey(meta.key);
  const bytes = new Uint8Array(meta.size);
  let offset = 0;
  for (let i = 0; i < meta.chunks; i++) {
    const part = await openChunk(aes, meta.blobId, i, meta.chunks, await api.getBlobChunk(meta.blobId, i));
    if (offset + part.length > meta.size) throw new Error("the file is longer than its envelope says");
    bytes.set(part, offset);
    offset += part.length;
    onProgress?.(offset);
  }
  if (offset !== meta.size || (await sha256Hex(bytes)) !== meta.sha256) {
    throw new Error("the downloaded file does not match its envelope");
  }
  return { meta, bytes };
}
