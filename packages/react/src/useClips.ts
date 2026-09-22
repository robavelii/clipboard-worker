/**
 * Clip history with client-side decryption.
 *
 * Search happens here rather than on the server: the server holds ciphertext,
 * so there is nothing for a SQL `LIKE` to match against.
 */

import { useCallback, useEffect, useState } from "react";
import type { Clip, SyncEvent } from "@clipsync/protocol";
import { decryptText, type VaultKeys } from "@clipsync/crypto";
import type { ApiClient } from "@clipsync/client";

const PAGE_SIZE = 100;

export interface DecryptedClip extends Clip {
  /** null when this clip was encrypted under a different passphrase. */
  text: string | null;
}

async function decryptAll(
  keys: VaultKeys,
  clips: Clip[],
): Promise<DecryptedClip[]> {
  return Promise.all(
    clips.map(async (clip) => {
      try {
        return { ...clip, text: await decryptText(keys, clip.envelope) };
      } catch {
        return { ...clip, text: null };
      }
    }),
  );
}

export function useClips(api: ApiClient, keys: VaultKeys) {
  const [clips, setClips] = useState<DecryptedClip[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (before?: number) => {
      try {
        const page = await api.listClips(PAGE_SIZE, before);
        const decrypted = await decryptAll(keys, page.clips);
        setClips((prev) => (before ? [...prev, ...decrypted] : decrypted));
        setCursor(page.nextCursor);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [api, keys],
  );

  useEffect(() => {
    void load();
  }, [load]);

  /** Apply a live event from the sync socket. */
  const applyEvent = useCallback(
    (event: SyncEvent) => {
      switch (event.type) {
        case "clip.created":
          void (async () => {
            const [decrypted] = await decryptAll(keys, [event.clip]);
            setClips((prev) =>
              prev.some((c) => c.id === decrypted!.id)
                ? prev
                : [decrypted!, ...prev],
            );
          })();
          break;
        case "clip.bumped":
          void (async () => {
            const [decrypted] = await decryptAll(keys, [event.clip]);
            // Remove then prepend: the clip already exists somewhere in the
            // list and has to move, not appear twice.
            setClips((prev) => [
              decrypted!,
              ...prev.filter((c) => c.id !== decrypted!.id),
            ]);
          })();
          break;
        case "clip.deleted":
          setClips((prev) => prev.filter((c) => c.id !== event.clipId));
          break;
        case "clip.pinned":
          setClips((prev) =>
            prev.map((c) =>
              c.id === event.clipId ? { ...c, pinned: event.pinned } : c,
            ),
          );
          break;
        default:
          break;
      }
    },
    [keys],
  );

  const remove = useCallback(
    async (id: string) => {
      setClips((prev) => prev.filter((c) => c.id !== id)); // optimistic
      try {
        await api.deleteClip(id);
      } catch {
        void load();
      }
    },
    [api, load],
  );

  const togglePin = useCallback(
    async (id: string, pinned: boolean) => {
      setClips((prev) =>
        prev.map((c) => (c.id === id ? { ...c, pinned } : c)),
      );
      try {
        await api.pinClip(id, pinned);
      } catch {
        void load();
      }
    },
    [api, load],
  );

  return {
    clips,
    loading,
    error,
    hasMore: cursor !== null,
    loadMore: () => (cursor ? load(cursor) : undefined),
    applyEvent,
    remove,
    togglePin,
    reload: () => load(),
  };
}
