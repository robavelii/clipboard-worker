/** Enough of the common types that images show inline in the web UI. */
const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  zip: "application/zip",
};

/** A file's MIME type from its name; application/octet-stream when unknown. */
export function mimeFor(name: string): string {
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  return MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
}

/** The usual extension for a MIME type, for naming an image that has no name. */
export function extensionFor(mime: string): string {
  if (mime === "image/jpeg") return "jpg";
  return Object.keys(MIME_BY_EXTENSION).find((ext) => MIME_BY_EXTENSION[ext] === mime) ?? "bin";
}
