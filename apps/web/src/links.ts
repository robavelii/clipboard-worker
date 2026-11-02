/**
 * Links in clips, made clickable. Only http and https: a copied
 * `javascript:` or `data:` URL stays text, since opening it would run it here.
 */

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;
/** Punctuation that ends a sentence more often than it ends a link. */
const TRAILING = /[.,;:!?)\]}'"»”’]+$/;

function safe(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Drop punctuation that ends the sentence, not the link. A closing bracket
 * stays when the link opened one: https://en.wikipedia.org/wiki/Foo_(bar).
 */
function trimEnd(raw: string): string {
  let s = raw;
  while (TRAILING.test(s)) {
    const last = s.at(-1)!;
    const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
    const open = pairs[last];
    if (open && s.split(open).length > s.split(last).length - 1) break;
    s = s.slice(0, -1);
  }
  return s;
}

/** The link when the whole clip is one link (spaces around it allowed); null otherwise. */
export function linkOf(text: string | null): string | null {
  const t = text?.trim() ?? "";
  if (!t || /\s/.test(t) || !/^https?:\/\//i.test(t)) return null;
  return safe(t);
}

export type Piece = string | { href: string; text: string };

/** The clip as text and links, in order, for rendering without innerHTML. */
export function linkify(text: string): Piece[] {
  const out: Piece[] = [];
  let at = 0;
  for (const m of text.matchAll(URL_RE)) {
    const raw = trimEnd(m[0]);
    const href = safe(raw);
    if (!href) continue;
    const start = m.index!;
    if (start > at) out.push(text.slice(at, start));
    out.push({ href, text: raw });
    at = start + raw.length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

/** "github.com/robavelii/…" for a button's title: the host and a little of the path. */
export function shortLink(href: string): string {
  const url = new URL(href);
  const rest = url.pathname === "/" ? "" : url.pathname;
  const tail = rest.length > 24 ? `${rest.slice(0, 24)}…` : rest;
  return `${url.host.replace(/^www\./, "")}${tail}`;
}
