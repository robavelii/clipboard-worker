/**
 * The R2 binding, on a directory: one file per object, at its key's path.
 *
 * Only what the Worker uses: `put`, `get` (body and bytes) and `delete` of
 * one key or many. A write goes to a temporary file and is renamed into
 * place, so a reader never sees half a chunk and a crash leaves no torn
 * object. Keys are the Worker's own (`blobs/<id>/<idx>`), but they are still
 * checked: nothing may resolve outside the directory.
 */

import { mkdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

export interface StoredObject {
  key: string;
  size: number;
  body: ReadableStream<Uint8Array>;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

type PutValue = ArrayBuffer | ArrayBufferView | string | ReadableStream | Blob | null;

export class DiskBucket {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private path(key: string): string {
    if (!key || key.includes("\0")) throw new Error(`invalid object key: ${JSON.stringify(key)}`);
    const path = resolve(this.root, key);
    if (!path.startsWith(this.root + sep)) throw new Error(`invalid object key: ${JSON.stringify(key)}`);
    return path;
  }

  async put(key: string, value: PutValue): Promise<{ key: string; size: number }> {
    const bytes = await toBytes(value);
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    const temp = join(dirname(path), `.${randomUUID()}.tmp`);
    await writeFile(temp, bytes);
    await rename(temp, path);
    return { key, size: bytes.byteLength };
  }

  async get(key: string): Promise<StoredObject | null> {
    let bytes: Buffer;
    try {
      bytes = await readFile(this.path(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const view = new Uint8Array(bytes); // a copy on its own ArrayBuffer
    return {
      key,
      size: view.byteLength,
      body: new Blob([view]).stream(),
      arrayBuffer: async () => view.slice().buffer,
      text: async () => new TextDecoder().decode(view),
    };
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      const path = this.path(key);
      await rm(path, { force: true });
      // Drop the blob's directory once its last chunk is gone.
      await rmdir(dirname(path)).catch(() => {});
    }
  }
}

async function toBytes(value: PutValue): Promise<Uint8Array> {
  if (value === null) return new Uint8Array();
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  return new Uint8Array(await new Response(value).arrayBuffer());
}
