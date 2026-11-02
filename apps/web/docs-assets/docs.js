/**
 * The docs' one script (build-docs.mjs): search, copy buttons on code, the
 * contents list folded away on a phone, and the "On this page" highlight.
 * The pages read fine without it; only search needs it.
 */

(() => {
  // ---------- contents: folded on a phone, open everywhere else ----------
  const docnav = document.querySelector(".docnav");
  const narrow = window.matchMedia("(max-width: 52rem)");
  const fold = () => {
    if (docnav) docnav.open = !narrow.matches;
  };
  fold();
  narrow.addEventListener("change", fold);

  // ---------- copy buttons ----------
  for (const block of document.querySelectorAll(".code")) {
    const code = block.querySelector("code");
    if (!code || !navigator.clipboard) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "copy";
    button.textContent = "Copy";
    button.addEventListener("click", () => {
      navigator.clipboard.writeText(code.textContent.replace(/\n$/, "")).then(
        () => {
          button.textContent = "Copied";
          button.dataset.done = "";
          setTimeout(() => {
            button.textContent = "Copy";
            delete button.dataset.done;
          }, 1600);
        },
        () => {
          button.textContent = "Copy failed";
        },
      );
    });
    block.append(button);
  }

  // ---------- on this page: the section being read ----------
  const tocLinks = [...document.querySelectorAll(".toc a")];
  if (tocLinks.length && "IntersectionObserver" in window) {
    const byId = new Map(tocLinks.map((a) => [a.hash.slice(1), a]));
    const visible = new Set();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        }
        const first = [...byId.keys()].find((id) => visible.has(id));
        if (!first) return;
        for (const [id, a] of byId) a.setAttribute("aria-current", String(id === first));
      },
      { rootMargin: "-56px 0px -60% 0px" },
    );
    for (const id of byId.keys()) {
      const heading = document.getElementById(id);
      if (heading) observer.observe(heading);
    }
  }

  // ---------- search ----------
  const input = document.getElementById("search");
  const list = document.getElementById("search-results");
  if (!input || !list) return;
  input.disabled = false;

  let index = null;
  let loading = null;
  const load = () =>
    (loading ??= fetch("/docs/search.json")
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => (index = data))
      .catch(() => (index = [])));

  const words = (q) => q.toLowerCase().split(/\s+/).filter(Boolean);

  function score(page, terms) {
    const title = page.title.toLowerCase();
    const text = page.text.toLowerCase();
    let total = 0;
    let heading = null;
    for (const term of terms) {
      let s = 0;
      if (title.includes(term)) s += 10;
      const h = page.headings.find((x) => x.text.toLowerCase().includes(term));
      if (h) {
        s += 6;
        heading ??= h;
      }
      if (text.includes(term)) s += 1;
      if (!s) return null; // every word must appear somewhere
      total += s;
    }
    return { total, heading };
  }

  function snippet(text, terms) {
    const lower = text.toLowerCase();
    const at = Math.max(0, lower.indexOf(terms[0]));
    const start = Math.max(0, at - 40);
    return (start ? "…" : "") + text.slice(start, start + 140);
  }

  function highlight(el, text, terms) {
    // Built from text nodes: nothing from the index is ever parsed as HTML.
    const pattern = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
    for (const part of text.split(pattern)) {
      if (!part) continue;
      if (terms.includes(part.toLowerCase())) {
        const mark = document.createElement("mark");
        mark.textContent = part;
        el.append(mark);
      } else el.append(part);
    }
  }

  let selected = -1;
  const items = () => [...list.querySelectorAll("a")];
  function select(i) {
    const all = items();
    if (!all.length) return;
    selected = (i + all.length) % all.length;
    all.forEach((a, n) => a.setAttribute("aria-selected", String(n === selected)));
    all[selected].scrollIntoView({ block: "nearest" });
  }

  function show(open) {
    list.hidden = !open;
    input.setAttribute("aria-expanded", String(open));
  }

  function run() {
    const terms = words(input.value);
    list.replaceChildren();
    selected = -1;
    if (!terms.length || !index) return show(false);
    const results = index
      .map((page) => ({ page, hit: score(page, terms) }))
      .filter((r) => r.hit)
      .sort((a, b) => b.hit.total - a.hit.total)
      .slice(0, 8);
    if (!results.length) {
      const li = document.createElement("li");
      li.className = "r-none";
      li.textContent = "Nothing matches.";
      list.append(li);
      return show(true);
    }
    for (const { page, hit } of results) {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = page.url + (hit.heading ? `#${hit.heading.id}` : "");
      a.setAttribute("role", "option");
      const title = document.createElement("span");
      title.className = "r-title";
      highlight(title, hit.heading ? hit.heading.text : page.title, terms);
      const where = document.createElement("span");
      where.className = "r-where";
      where.textContent = hit.heading ? `${page.section} · ${page.title}` : page.section;
      const text = document.createElement("span");
      text.className = "r-text";
      highlight(text, snippet(page.text, terms), terms);
      a.append(title, where, text);
      li.append(a);
      list.append(li);
    }
    show(true);
  }

  input.addEventListener("focus", () => void load().then(run));
  input.addEventListener("input", () => void load().then(run));
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      select(selected + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      select(selected - 1);
    } else if (e.key === "Enter") {
      const target = items()[selected] ?? items()[0];
      if (target) {
        e.preventDefault();
        window.location.href = target.href;
      }
    } else if (e.key === "Escape") {
      input.value = "";
      run();
      input.blur();
    }
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".search")) show(false);
  });
  document.addEventListener("keydown", (e) => {
    const typing = e.target.closest("input, textarea, select, [contenteditable]");
    if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      input.focus();
    }
  });
})();
