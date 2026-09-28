/**
 * Clip history with client-side decryption.
 *
 * Search happens here rather than on the server: the server holds ciphertext,
 * so there is nothing for a SQL `LIKE` to match against.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Clip, SyncEvent } from "@clipsync/protocol";
import type { ApiClient } from "@clipsync/client";
import { decryptClip, type RingKeys } from "@clipsync/client/ring";

const PAGE_SIZE = 100;

export interface DecryptedClip extends Clip {
  /**
   * null when this clip does not open: encrypted under a different
   * passphrase, under a key epoch this device does not hold, or not the
   * clip its row claims (see readClip).
   */
  text: string | null;
}

async function decryptAll(
  keys: RingKeys,
  account: string,
  clips: Clip[],
): Promise<DecryptedClip[]> {
  return Promise.all(
    clips.map(async (clip) => {
      try {
        return { ...clip, text: await decryptClip(keys, clip, account) };
      } catch {
        return { ...clip, text: null };
      }
    }),
  );
}

/** Append `more`, skipping any clip already present. */
function mergeClips(
  base: DecryptedClip[],
  more: DecryptedClip[],
): DecryptedClip[] {
  const seen = new Set(base.map((c) => c.id));
  return [...base, ...more.filter((c) => !seen.has(c.id))];
}

/**
 * Display order: pinned first, then newest first.
 *
 * Pinning is how you keep something from scrolling away under whatever was
 * copied a minute ago, so it has to change where a clip sits, not only how it
 * looks.
 */
export function sortForDisplay(clips: DecryptedClip[]): DecryptedClip[] {
  return [...clips].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt - a.createdAt,
  );
}

/**
 * `keys` changes identity when a re-key adds an epoch, which reloads the
 * list: clips that arrived under the new key before this device held it
 * open on the second pass.
 */
export function useClips(api: ApiClient, keys: RingKeys, account: string) {
  const [clips, setClips] = useState<DecryptedClip[]>([]);
  const [cursor, setCursor] = useState<string | number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (before?: string | number) => {
      try {
        // The first page comes with every pin, however old: pins sort to
        // the top, so one beyond the first page would otherwise be missing
        // from exactly where it belongs until "load more" reached it.
        const [page, pinned] = await Promise.all([
          api.listClips(PAGE_SIZE, before),
          before ? null : api.listPinned(),
        ]);
        const decrypted = await decryptAll(keys, account, page.clips);
        const decryptedPins = pinned ? await decryptAll(keys, account, pinned.clips) : [];
        setClips((prev) =>
          before
            ? mergeClips(prev, decrypted)
            : mergeClips(decryptedPins, decrypted),
        );
        setCursor(page.nextCursor);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [api, keys, account],
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
            const [decrypted] = await decryptAll(keys, account, [event.clip]);
            setClips((prev) =>
              prev.some((c) => c.id === decrypted!.id)
                ? prev
                : [decrypted!, ...prev],
            );
          })();
          break;
        case "clip.bumped":
          void (async () => {
            const [decrypted] = await decryptAll(keys, account, [event.clip]);
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
    [keys, account],
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

  const ordered = useMemo(() => sortForDisplay(clips), [clips]);

  // Stable, so callers can use it as an effect dependency.
  const reload = useCallback(() => load(), [load]);

  return {
    /** Already in display order; see sortForDisplay. */
    clips: ordered,
    loading,
    error,
    hasMore: cursor !== null,
    loadMore: () => (cursor !== null ? load(cursor) : undefined),
    applyEvent,
    remove,
    togglePin,
    reload,
  };
}
