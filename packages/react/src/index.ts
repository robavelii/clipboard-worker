/**
 * React hooks shared by the web UI and the desktop tray app.
 *
 * Both render the same clipboard history against the same live socket; the
 * only thing that differs is how they obtain credentials. Keeping the hooks
 * here means a fix to reconnection or to event handling lands in both.
 */

export { useClips, type DecryptedClip } from "./useClips";
export { useSync, type SyncStatus } from "./useSync";
