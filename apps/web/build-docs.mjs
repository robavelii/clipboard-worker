/**
 * Builds the documentation at /docs (decisions §53): the Markdown pages in
 * docs/, rendered to static HTML in dist/docs/ after `vite build`.
 *
 * The pages share the web UI's origin, and so its CSP: no inline script or
 * style, no style attribute. Everything is decided here, at build time:
 * highlighting is highlight.js's class names, not inline colours, and the
 * one script (search, code copy buttons, the contents toggle) is a file.
 * Nothing on these pages works differently without it, except search.
 *
 * The build fails on a link to a page or heading that does not exist.
 *
 *   node build-docs.mjs            after vite build (npm run build)
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Marked } from "marked";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import ini from "highlight.js/lib/languages/ini";
import json from "highlight.js/lib/languages/json";
import powershell from "highlight.js/lib/languages/powershell";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("ini", ini);
hljs.registerLanguage("json", json);
hljs.registerLanguage("powershell", powershell);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerAliases(["sh", "shell", "console"], { languageName: "bash" });
hljs.registerAliases(["ts"], { languageName: "typescript" });
hljs.registerAliases(["jsonc"], { languageName: "json" });
hljs.registerAliases(["ps1"], { languageName: "powershell" });
hljs.registerAliases(["html", "plist"], { languageName: "xml" });

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, "docs");
const out = join(here, "dist", "docs");
const REPO = "https://github.com/robavelii/clipboard-worker";

// ---------- small helpers ----------

const escapeHtml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** GitHub's heading ids, near enough: lowercase, punctuation dropped, spaces to dashes. */
const slugify = (text) =>
  text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z]+;|&#\d+;/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");

/** Plain text of a bit of rendered HTML, for the search index. */
const textOf = (html) =>
  html
    .replace(/<a class="anchor"[^>]*>#<\/a>/g, "")
    .replace(/<pre[\s\S]*?<\/pre>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

function frontMatter(raw, file) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(raw);
  if (!match) throw new Error(`${file}: no front matter (--- title: … ---)`);
  const meta = {};
  for (const line of match[1].split("\n")) {
    const colon = line.indexOf(":");
    if (colon > 0) meta[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  if (!meta.title) throw new Error(`${file}: front matter has no title`);
  return { meta, body: raw.slice(match[0].length) };
}

/** Where a page lives: the overview at /docs/, the rest at /docs/<slug>. */
const urlOf = (slug) => (slug === "index" ? "/docs/" : `/docs/${slug}`);

function findPackage(name) {
  for (let dir = here; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) throw new Error(`cannot find ${name}`);
  }
}

// ---------- the pages ----------

const nav = JSON.parse(readFileSync(join(source, "nav.json"), "utf8"));
const order = nav.flatMap((section) => section.pages.map((slug) => ({ slug, section: section.title })));
const files = readdirSync(source).filter((f) => f.endsWith(".md"));
for (const file of files) {
  if (!order.some((p) => `${p.slug}.md` === file)) throw new Error(`docs/${file} is not in docs/nav.json`);
}

/** Links to check once every page is rendered: [from, slug, anchor]. */
const links = [];

function render(slug, body) {
  const headings = [];
  const seen = new Map();
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      heading({ tokens, depth }) {
        const inner = this.parser.parseInline(tokens);
        let id = slugify(inner);
        const n = seen.get(id) ?? 0;
        seen.set(id, n + 1);
        if (n) id = `${id}-${n}`;
        if (depth === 2 || depth === 3) headings.push({ depth, id, text: textOf(inner) });
        if (depth === 1) return `<h1>${inner}</h1>\n`;
        return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true" tabindex="-1">#</a>${inner}</h${depth}>\n`;
      },
      code({ text, lang }) {
        const language = (lang ?? "").split(/\s/)[0];
        const known = language && hljs.getLanguage(language);
        const html = known ? hljs.highlight(text, { language }).value : escapeHtml(text);
        const label = known ? `<span class="code-lang">${escapeHtml(language)}</span>` : "";
        return `<div class="code">${label}<pre><code class="hljs${known ? ` language-${language}` : ""}">${html}</code></pre></div>\n`;
      },
      link({ href, title, tokens }) {
        const inner = this.parser.parseInline(tokens);
        const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
        // A page of these docs, as GitHub links it: other.md#anchor, or #anchor.
        const local = /^(?:([\w-]+)\.md)?(?:#([\w-]+))?$/.exec(href);
        if (local && (local[1] || local[2])) {
          const target = local[1] ?? slug;
          links.push([slug, target, local[2] ?? null]);
          const url = (target === slug && !local[1] ? "" : urlOf(target)) + (local[2] ? `#${local[2]}` : "");
          return `<a href="${url}"${titleAttr}>${inner}</a>`;
        }
        if (/^https?:\/\//.test(href)) {
          return `<a href="${escapeHtml(href)}"${titleAttr} rel="noopener">${inner}</a>`;
        }
        // A path on this server (/install.sh, /phone): left as it is.
        return `<a href="${escapeHtml(href)}"${titleAttr}>${inner}</a>`;
      },
      blockquote({ tokens }) {
        const inner = this.parser.parse(tokens);
        // GitHub's alerts, so the Markdown reads the same there: > [!NOTE]
        const alert = /^<p>\[!(NOTE|TIP|WARNING|IMPORTANT)\]\s*/.exec(inner);
        if (!alert) return `<blockquote>${inner}</blockquote>\n`;
        const kind = alert[1].toLowerCase();
        const names = { note: "Note", tip: "Tip", warning: "Warning", important: "Important" };
        return `<aside class="callout ${kind}"><p class="callout-title">${names[kind]}</p><p>${inner.slice(alert[0].length)}</aside>\n`;
      },
    },
  });
  // A wide table scrolls on its own, not the page.
  const html = marked
    .parse(body)
    .replace(/<table>/g, '<div class="table-wrap"><table>')
    .replace(/<\/table>/g, "</table></div>");
  const title = /<h1>([\s\S]*?)<\/h1>/.exec(html);
  if (!title) throw new Error(`docs/${slug}.md has no # heading`);
  return { html: html.replace(title[0], ""), h1: title[1], headings };
}

const pages = order.map(({ slug, section }) => {
  const file = join(source, `${slug}.md`);
  if (!existsSync(file)) throw new Error(`docs/nav.json names ${slug}, but docs/${slug}.md does not exist`);
  const { meta, body } = frontMatter(readFileSync(file, "utf8").replace(/\r\n?/g, "\n"), `docs/${slug}.md`);
  return { slug, section, meta, ...render(slug, body) };
});

function checkLinks() {
for (const [from, target, anchor] of links) {
  const page = pages.find((p) => p.slug === target);
  if (!page) throw new Error(`docs/${from}.md links to ${target}.md, which does not exist`);
  if (anchor && !page.headings.some((h) => h.id === anchor) && !page.html.includes(`id="${anchor}"`)) {
    throw new Error(`docs/${from}.md links to ${target}.md#${anchor}, which has no such heading`);
  }
}
}

// ---------- the layout ----------

/** Links to the site pages (below), in every page's foot; empty when there are none. */
let legalLinks = "";

function sidebar(current) {
  const sections = nav
    .map((section) => {
      const items = section.pages
        .map((slug) => {
          const page = pages.find((p) => p.slug === slug);
          const here = slug === current ? ' aria-current="page"' : "";
          return `<li><a href="${urlOf(slug)}"${here}>${page.meta.nav ?? page.meta.title}</a></li>`;
        })
        .join("");
      return `<div class="nav-section"><p class="nav-title">${section.title}</p><ul>${items}</ul></div>`;
    })
    .join("");
  // Open by default, so it works without the script; docs.js closes it on a phone.
  return `<details class="docnav" open><summary>Contents</summary><nav aria-label="Documentation">${sections}</nav></details>`;
}

function toc(headings) {
  const items = headings.filter((h) => h.depth === 2);
  if (items.length < 2) return "";
  const list = items.map((h) => `<li><a href="#${h.id}">${escapeHtml(h.text)}</a></li>`).join("");
  return `<aside class="toc" aria-label="On this page"><p class="nav-title">On this page</p><ul>${list}</ul></aside>`;
}

function pager(index) {
  const prev = pages[index - 1];
  const next = pages[index + 1];
  const link = (page, rel, label) =>
    page
      ? `<a class="pager-${rel}" href="${urlOf(page.slug)}" rel="${rel}"><span>${label}</span>${page.meta.nav ?? page.meta.title}</a>`
      : "<span></span>";
  return `<nav class="pager" aria-label="Previous and next">${link(prev, "prev", "Previous")}${link(next, "next", "Next")}</nav>`;
}

function layout(page, index) {
  const title = page.slug === "index" ? "ClipSync docs" : `${page.meta.title} · ClipSync docs`;
  const description = page.meta.description ? `<meta name="description" content="${escapeHtml(page.meta.description)}" />` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#1a1d21" />
<meta name="theme-color" media="(prefers-color-scheme: light)" content="#f8f6f2" />
<title>${escapeHtml(title)}</title>
${description}
<link rel="icon" href="/icon-192.png" />
<link rel="stylesheet" href="/docs/docs.css" />
<script src="/docs/docs.js" defer></script>
</head>
<body>
<a class="skip" href="#content">Skip to the page</a>
<header class="topbar">
  <a class="brand" href="/docs/">ClipSync <span>docs</span></a>
  <div class="search" role="search">
    <label class="visually-hidden" for="search">Search the docs</label>
    <input id="search" type="search" placeholder="Search" autocomplete="off" spellcheck="false" aria-keyshortcuts="/" aria-controls="search-results" aria-expanded="false" disabled />
    <kbd aria-hidden="true">/</kbd>
    <ul id="search-results" class="search-results" role="listbox" hidden></ul>
  </div>
  <nav class="toplinks" aria-label="Elsewhere">
    <a href="${REPO}" rel="noopener">GitHub</a>
    <a class="open-app" href="/">Open ClipSync</a>
  </nav>
</header>
<div class="shell">
  ${sidebar(page.slug)}
  <main id="content" class="page">
    <p class="eyebrow">${escapeHtml(page.section)}</p>
    <h1>${page.h1}</h1>
    ${page.meta.description ? `<p class="lead">${escapeHtml(page.meta.description)}</p>` : ""}
    <div class="prose">
${page.html}
    </div>
    <footer class="page-foot">
      <a href="${REPO}/edit/main/apps/web/docs/${page.slug}.md" rel="noopener">Edit this page on GitHub</a>
      ${legalLinks}
    </footer>
    ${pager(index)}
  </main>
  ${toc(page.headings)}
</div>
</body>
</html>
`;
}

// ---------- site pages: an operator's own pages, at /<slug> ----------

/*
 * A hosted service adds pages beside the docs (pricing and policies, say)
 * from its own directory, named by SITE_DIR: Markdown with the docs' front
 * matter, rendered here without the sidebar, under the same CSP. Values that
 * differ per operator live in that directory's site.json and fill {{key}}
 * placeholders. This repository has none; a self-hosted server serves only
 * the app and the docs.
 */
const siteSource = process.env.SITE_DIR ? resolve(process.env.SITE_DIR) : null;
const siteInfo = siteSource ? JSON.parse(readFileSync(join(siteSource, "site.json"), "utf8")) : {};
const siteName = siteInfo.tradingName ?? "ClipSync";
const fill = (text, file) =>
  text.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in siteInfo)) throw new Error(`${file} uses {{${key}}}, which site.json does not define`);
    return siteInfo[key];
  });
const sitePages = (siteSource ? readdirSync(siteSource) : [])
  .filter((f) => f.endsWith(".md"))
  .map((file) => {
    const slug = file.slice(0, -3);
    if (pages.some((p) => p.slug === slug) || ["docs", "api", "index"].includes(slug)) {
      throw new Error(`${file} would shadow /${slug}`);
    }
    const { meta, body } = frontMatter(fill(readFileSync(join(siteSource, file), "utf8").replace(/\r\n?/g, "\n"), file), file);
    return { slug, meta, ...render(slug, body) };
  })
  .sort((a, b) => Number(a.meta.order ?? 99) - Number(b.meta.order ?? 99));
for (const [key, value] of Object.entries(siteInfo)) {
  if (/TODO/.test(String(value))) console.warn(`site.json: ${key} is still a placeholder`);
}
if (sitePages.length) {
  legalLinks = `<nav class="legal" aria-label="About this service">${sitePages
    .map((p) => `<a href="/${p.slug}">${escapeHtml(p.meta.nav ?? p.meta.title)}</a>`)
    .join("")}</nav>`;
}
// Docs links from the site pages too (a link from pricing.md to limits.md).
checkLinks();

function siteLayout(page) {
  const description = page.meta.description ? `<meta name="description" content="${escapeHtml(page.meta.description)}" />` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#1a1d21" />
<meta name="theme-color" media="(prefers-color-scheme: light)" content="#f8f6f2" />
<title>${escapeHtml(page.meta.title)} · ${escapeHtml(siteName)}</title>
${description}
<link rel="icon" href="/icon-192.png" />
<link rel="stylesheet" href="/docs/docs.css" />
</head>
<body>
<a class="skip" href="#content">Skip to the page</a>
<header class="topbar">
  <a class="brand" href="/">${escapeHtml(siteName)}</a>
  <nav class="toplinks" aria-label="Elsewhere">
    <a href="/docs/">Docs</a>
    <a class="open-app" href="/">Open ${escapeHtml(siteName)}</a>
  </nav>
</header>
<div class="shell single">
  <main id="content" class="page">
    <h1>${page.h1}</h1>
    ${page.meta.description ? `<p class="lead">${escapeHtml(page.meta.description)}</p>` : ""}
    ${page.meta.updated ? `<p class="updated">Last updated ${escapeHtml(page.meta.updated)}</p>` : ""}
    <div class="prose">
${page.html}
    </div>
    <footer class="page-foot">${legalLinks}</footer>
  </main>
</div>
</body>
</html>
`;
}

// ---------- write it all ----------

mkdirSync(join(out, "fonts"), { recursive: true });
pages.forEach((page, index) => {
  writeFileSync(join(out, page.slug === "index" ? "index.html" : `${page.slug}.html`), layout(page, index));
});

for (const page of sitePages) writeFileSync(join(here, "dist", `${page.slug}.html`), siteLayout(page));
// The web app links the site pages from its sign-in screen when this lists any.
writeFileSync(
  join(here, "dist", "site-pages.json"),
  JSON.stringify(sitePages.map((p) => ({ path: `/${p.slug}`, title: p.meta.nav ?? p.meta.title }))),
);

writeFileSync(
  join(out, "search.json"),
  JSON.stringify(
    pages.map((page) => ({
      title: page.meta.title,
      section: page.section,
      url: urlOf(page.slug),
      headings: page.headings.map(({ id, text }) => ({ id, text })),
      text: textOf(page.html).slice(0, 6000),
    })),
  ),
);

const fonts = [
  ["@fontsource/host-grotesk", "host-grotesk-latin-400-normal.woff2"],
  ["@fontsource/host-grotesk", "host-grotesk-latin-500-normal.woff2"],
  ["@fontsource/atkinson-hyperlegible-mono", "atkinson-hyperlegible-mono-latin-400-normal.woff2"],
];
for (const [pkg, file] of fonts) copyFileSync(join(findPackage(pkg), "files", file), join(out, "fonts", file));

const css = [
  readFileSync(join(here, "src", "tokens.css"), "utf8"),
  readFileSync(join(here, "src", "base.css"), "utf8"),
  readFileSync(join(here, "docs-assets", "docs.css"), "utf8"),
].join("\n");
writeFileSync(join(out, "docs.css"), css);
copyFileSync(join(here, "docs-assets", "docs.js"), join(out, "docs.js"));

console.log(`docs: ${pages.length} pages, ${sitePages.length} site pages, ${links.length} links checked → dist/`);
