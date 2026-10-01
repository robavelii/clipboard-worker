/** Commit the bundle was built from, or a release's tag; injected by build.mjs. */
declare const __CLIPSYNC_BUILD__: string;

/** The GitHub releases this build updates itself from; injected by build.mjs. */
declare const __CLIPSYNC_RELEASES__: string;

/** The built web UI, keyed "/path"; null in a bundle built without it. Supplied by apps/server/build-plugin.mjs. */
declare module "clipsync:web-files" {
  const files: Record<string, Uint8Array<ArrayBuffer>> | null;
  export default files;
}
