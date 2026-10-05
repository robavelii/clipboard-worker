/**
 * Encrypted image and file bytes, in R2.
 *
 * A client reserves a blob, uploads its chunks one request each, then creates
 * the clip that adopts it (POST /api/clips with `blobId`). Chunks are
 * ciphertext under a key only the clip's envelope holds; the server stores
 * and returns them without being able to read or reorder them usefully
 * (each chunk's associated data names its blob, index and count).
 */

import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  BLOB_CHUNK_BYTES,
  BLOB_CHUNK_OVERHEAD,
  MAX_FILE_BYTES,
  R2_BUDGET_ERROR,
  type ApiError,
  type BlobUsageResponse,
  type CreateBlobRequest,
  type CreateBlobResponse,
} from "@clipsync/protocol";
import { requireDevice, type AuthVars } from "../auth";
import { newId } from "../ids";
import { chunkKey, deleteBlobs, reserveBlob, spend, usage } from "../r2";

type AppEnv = { Bindings: Env; Variables: AuthVars };

const MAX_CHUNKS = Math.ceil(MAX_FILE_BYTES / BLOB_CHUNK_BYTES);
const MAX_CHUNK_CIPHERTEXT = BLOB_CHUNK_BYTES + BLOB_CHUNK_OVERHEAD;

export interface BlobRow {
  id: string;
  user_id: string;
  chunks: number;
  size: number;
  created_at: number;
  attached_at: number | null;
}

function overBudget(c: Context<AppEnv>, what: string) {
  return c.json<ApiError>(
    {
      error: R2_BUDGET_ERROR,
      message: what,
    },
    429,
  );
}

async function ownBlob(c: Context<AppEnv>, id: string): Promise<BlobRow> {
  const blob = await c.env.DB.prepare("SELECT * FROM blobs WHERE id = ? AND user_id = ?")
    .bind(id, c.var.device.userId)
    .first<BlobRow>();
  if (!blob) throw new HTTPException(404, { message: "blob not found" });
  return blob;
}

function chunkIndex(raw: string, blob: BlobRow): number {
  const idx = Number(raw);
  if (!Number.isInteger(idx) || idx < 0 || idx >= blob.chunks) {
    throw new HTTPException(400, { message: `chunk index must be 0 to ${blob.chunks - 1}` });
  }
  return idx;
}

export const blobRoutes = new Hono<AppEnv>()

  .use("*", requireDevice)

  /** This month's R2 use against the budget. */
  .get("/usage", async (c) => c.json<BlobUsageResponse>(await usage(c.env, c.var.device)))

  /**
   * Reserve room for a blob. Storage is checked here, against the declared
   * size, so the budget holds before a byte is uploaded; the oldest unpinned
   * files make way if they must.
   */
  .post("/", async (c) => {
    const body = await c.req.json<Partial<CreateBlobRequest>>().catch(() => ({}) as Partial<CreateBlobRequest>);
    const chunks = body.chunks;
    const bytes = body.bytes;
    if (
      !Number.isInteger(chunks) ||
      !Number.isInteger(bytes) ||
      chunks! < 1 ||
      chunks! > MAX_CHUNKS ||
      bytes! <= chunks! * BLOB_CHUNK_OVERHEAD ||
      bytes! > chunks! * MAX_CHUNK_CIPHERTEXT
    ) {
      throw new HTTPException(400, {
        message: `chunks must be 1 to ${MAX_CHUNKS}, and bytes what they hold (files up to ${MAX_FILE_BYTES} bytes)`,
      });
    }
    const id = newId("blob");
    if (!(await reserveBlob(c.env, c.var.device, id, chunks!, bytes!))) {
      return overBudget(c, "no room for this file: storage is full, and none of your files can make room (pinned files stay; a plan may cap the total)");
    }
    return c.json<CreateBlobResponse>({ id });
  })

  /** Upload one chunk. Idempotent: a retry overwrites. */
  .put("/:id/:idx", async (c) => {
    const blob = await ownBlob(c, c.req.param("id"));
    if (blob.attached_at !== null) {
      throw new HTTPException(409, { message: "blob is already part of a clip" });
    }
    const idx = chunkIndex(c.req.param("idx"), blob);
    const data = await c.req.arrayBuffer();
    if (data.byteLength <= BLOB_CHUNK_OVERHEAD || data.byteLength > MAX_CHUNK_CIPHERTEXT) {
      throw new HTTPException(400, { message: "chunk size out of range" });
    }

    // Within the declared total, counting this chunk as replacing any
    // earlier upload of the same index.
    const others = await c.env.DB.prepare(
      "SELECT COALESCE(SUM(size), 0) AS bytes FROM blob_chunks WHERE blob_id = ? AND idx != ?",
    )
      .bind(blob.id, idx)
      .first<{ bytes: number }>();
    if ((others?.bytes ?? 0) + data.byteLength > blob.size) {
      throw new HTTPException(400, { message: "chunks exceed the blob's declared size" });
    }

    if (!(await spend(c.env, c.var.device, "a"))) return overBudget(c, "the monthly upload budget is spent (the server's, or this account's plan); it resets next month");
    await c.env.BLOBS.put(chunkKey(blob.id, idx), data);
    await c.env.DB.prepare(
      "INSERT OR REPLACE INTO blob_chunks (blob_id, idx, size) VALUES (?, ?, ?)",
    )
      .bind(blob.id, idx, data.byteLength)
      .run();
    return c.json({ ok: true });
  })

  /** Download one chunk. */
  .get("/:id/:idx", async (c) => {
    const blob = await ownBlob(c, c.req.param("id"));
    const idx = chunkIndex(c.req.param("idx"), blob);
    if (!(await spend(c.env, c.var.device, "b"))) return overBudget(c, "the monthly download budget is spent (the server's, or this account's plan); it resets next month");
    const object = await c.env.BLOBS.get(chunkKey(blob.id, idx));
    if (!object) throw new HTTPException(404, { message: "chunk not uploaded" });
    return new Response(object.body, {
      headers: {
        "content-type": "application/octet-stream",
        "cache-control": "no-store",
      },
    });
  })

  /** Abandon an upload no clip has adopted. */
  .delete("/:id", async (c) => {
    const blob = await ownBlob(c, c.req.param("id"));
    if (blob.attached_at !== null) {
      throw new HTTPException(409, { message: "delete the clip instead" });
    }
    await deleteBlobs(c.env, [blob.id]);
    return c.json({ ok: true });
  });
