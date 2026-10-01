/**
 * The Workers runtime APIs the Worker's code calls that Node lacks.
 *
 * One so far: `crypto.subtle.timingSafeEqual`, a Cloudflare extension the
 * bootstrap route compares ADMIN_SECRET with. Installed on the global before
 * the app handles a request; a no-op where it already exists.
 */

import { timingSafeEqual } from "node:crypto";

type Bytes = ArrayBuffer | ArrayBufferView;

function view(value: Bytes): Uint8Array {
  return value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

export function installWorkersRuntime(): void {
  const subtle = globalThis.crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (a: Bytes, b: Bytes) => boolean;
  };
  if (typeof subtle.timingSafeEqual === "function") return;
  Object.defineProperty(subtle, "timingSafeEqual", {
    value(a: Bytes, b: Bytes): boolean {
      const left = view(a);
      const right = view(b);
      // Workers throws on a length mismatch too; callers compare lengths first.
      if (left.byteLength !== right.byteLength) throw new TypeError("Input buffers must have the same length");
      return timingSafeEqual(left, right);
    },
  });
}
