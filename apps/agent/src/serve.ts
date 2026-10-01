/**
 * `clipsync serve`: the ClipSync server itself (apps/server), carried by
 * this binary with the web UI built in, so one download runs either end
 * (decisions §40). The CLI loads this module only for `serve`.
 */

import { serve } from "@clipsync/server/serve";
import webFiles from "clipsync:web-files";

export function cmdServe(argv: string[]): Promise<void> {
  return serve(argv, { command: "clipsync serve", web: webFiles });
}
