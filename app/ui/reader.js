// SPDX-License-Identifier: AGPL-3.0-or-later
// Reading features of the Read view (READER-PLAN.md, phase R1): selectable text, links, find while reading,
// bookmarks, back and forward, view options (fit page, two pages, rotate view, night reading), full screen,
// presentation, and reopening last session's tabs. None of this changes the file: it only affects what is shown.
//
// Positions: pdf.js gives text and links in PDF space; a viewport with the page's own rotation plus the
// plan's rotation turns them into on-screen points, from which the plan's crop (top, left) is subtracted.
// That matches how app.js draws each page (drawEntry).

const SESSION_KEY = "awpdfeditor.session.v1";

export function createReader(ctx) {
  const { state, h, icon, invoke, modal, actions, toast, pdfjs } = ctx;
  const textCache = new Map(); // `${uid}|${src}:${page}` -> Promise<{ str, pieces }>
  let find = null; // { doc, query, matches: [{ index, rects }], at, busy }
  let findTimer = null;

  const read = (doc = state.doc) => (doc.read ||= { layout: "single", turn: 0, back: [], forward: [], panel: "pages" });

  // ---------- Selectable text and links on each drawn page ----------

  async function viewportOf(entry, scale) {
    const page = await state.doc.sources[entry.src].pdf.getPage(entry.page);
    return { page, viewport: page.getViewport({ scale, rotation: (page.rotate + (entry.rotate || 0)) % 360 }) };
  }

  /** Adds the text layer (select, copy) and link areas to a page that has just been drawn. */
  async function decorate(slot, entry, index, zoom) {
    const doc = state.doc;
    if (!doc || doc.view !== "pages" || entry.blank) { drawFind(slot, index, zoom); return; }
    const { page, viewport } = await viewportOf(entry, zoom);
    if (!slot.isConnected) return;
    const [t, , , l] = entry.crop || [0, 0, 0, 0];
    const holder = h("div", { class: "rd-layers", style: `left:${-l * zoom}px;top:${-t * zoom}px;width:${viewport.width}px;height:${viewport.height}px` });
    holder.style.setProperty("--scale-factor", String(zoom));
    const text = h("div", { class: "textLayer" });
    holder.append(text);
    for (const a of await page.getAnnotations({ intent: "display" })) {
      if (a.subtype !== "Link" || !(a.url || a.dest || a.action)) continue;
      const [x0, y0, x1, y1] = viewport.convertToViewportRectangle(a.rect);
      holder.append(h("a", {
        class: "rd-link", href: "#", title: a.url || (a.dest ? "Go to the linked page" : ""),
        style: `left:${Math.min(x0, x1)}px;top:${Math.min(y0, y1)}px;width:${Math.abs(x1 - x0)}px;height:${Math.abs(y1 - y0)}px`,
        onclick: (event) => { event.preventDefault(); followLink(a, entry); },
      }));
    }
    slot.querySelector(".rd-layers")?.remove();
    slot.insertBefore(holder, slot.querySelector(".mk-layer"));
    try {
      await new pdfjs.TextLayer({ textContentSource: page.streamTextContent({ includeMarkedContent: true, disableNormalization: true }), container: text, viewport }).render();
      text.append(h("div", { class: "endOfContent" }));
    } catch { /* a page whose text can't be read is still shown */ }
    drawFind(slot, index, zoom);
  }

  // ---------- Links, bookmarks, back and forward ----------

  /** The plan index showing page `pageIndex` (0-based) of source `src`, or -1 if it was removed. */
  const planIndex = (src, pageIndex) => state.doc.pages.findIndex((p) => !p.blank && p.src === src && p.page === pageIndex + 1);

  async function resolveDest(src, dest) {
    const pdf = state.doc.sources[src].pdf;
    const explicit = typeof dest === "string" ? await pdf.getDestination(dest) : dest;
    if (!Array.isArray(explicit) || !explicit.length) return null;
    const target = explicit[0];
    const pageIndex = typeof target === "number" ? target : await pdf.getPageIndex(target);
    // [ref, {name: "XYZ"}, left, top, zoom]: remember the top, so the jump lands on the heading.
    const top = explicit[1]?.name === "XYZ" && typeof explicit[3] === "number" ? explicit[3] : null;
    return { pageIndex, top };
  }

  async function followLink(a, entry) {
    if (a.url) {
      const ok = await modal((close) => [
        h("h2", { text: "Open this link?" }),
        h("p", { class: "sm muted", text: "The PDF links to a page on the web. It opens in your browser." }),
        h("div", { class: "subtle-box sm ellipsis", text: a.url, title: a.url }),
        actions(h("button", { class: "btn", type: "button", text: "Cancel", onclick: () => close(false) }),
          h("button", { class: "btn primary", type: "button", text: "Open in browser", onclick: () => close(true) })),
      ], { label: "Open link" });
      if (ok) invoke("open_link", { url: a.url }).catch((error) => toast(String(error.message || error), null, true));
      return;
    }
    const doc = state.doc;
    if (a.action) { // Named actions: NextPage, PrevPage, FirstPage, LastPage, GoBack
      const go = { NextPage: doc.current + 1, PrevPage: doc.current - 1, FirstPage: 0, LastPage: doc.pages.length - 1 }[a.action];
      if (a.action === "GoBack") back(); else if (go !== undefined) jump(go);
      return;
    }
    await jumpToDest(entry.src, a.dest);
  }

  async function jumpToDest(src, dest) {
    const found = await resolveDest(src, dest).catch(() => null);
    if (!found) { toast("That link points to nothing in this PDF.", null, true); return; }
    const index = planIndex(src, found.pageIndex);
    if (index < 0) { toast("The page it points to isn't in this document any more.", null, true); return; }
    let y = null;
    if (found.top !== null) {
      const { viewport } = await viewportOf(state.doc.pages[index], 1);
      y = viewport.convertToViewportPoint(0, found.top)[1] - (state.doc.pages[index].crop?.[0] || 0);
    }
    jump(index, y);
  }

  /** Moves to a page (and a point on it, in points), remembering where we were for Back. */
  function jump(index, y = null) {
    const doc = state.doc;
    const r = read(doc);
    const container = document.getElementById("pages");
    r.back.push({ index: doc.current, top: container?.scrollTop ?? null });
    if (r.back.length > 100) r.back.shift();
    r.forward = [];
    scrollTo(index, y);
    refreshHistoryButtons();
  }

  function scrollTo(index, y = null, top = null) {
    const doc = state.doc;
    const container = document.getElementById("pages");
    const target = Math.min(Math.max(index, 0), doc.pages.length - 1);
    if (top !== null && container) { container.scrollTop = top; return; }
    const slot = ctx.slots()?.[target];
    if (!container || !slot) { ctx.goToPage(target); return; }
    const offset = slot.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
    container.scrollTo({ top: Math.max(0, offset + (y === null ? 0 : y * doc.zoom - 24)), behavior: "auto" });
  }

  function back() {
    const r = read();
    const to = r.back.pop();
    if (!to) return;
    r.forward.push({ index: state.doc.current, top: document.getElementById("pages")?.scrollTop ?? null });
    scrollTo(to.index, null, to.top);
    refreshHistoryButtons();
  }
  function forward() {
    const r = read();
    const to = r.forward.pop();
    if (!to) return;
    r.back.push({ index: state.doc.current, top: document.getElementById("pages")?.scrollTop ?? null });
    scrollTo(to.index, null, to.top);
    refreshHistoryButtons();
  }
  function refreshHistoryButtons() {
    const r = state.doc && read();
    const b = document.getElementById("rd-back"), f = document.getElementById("rd-forward");
    if (b) b.disabled = !r?.back.length;
    if (f) f.disabled = !r?.forward.length;
  }

  /** The bookmarks panel (the PDF's outline). A PDF made from several files shows each file's bookmarks. */
  async function layoutOutline(strip) {
    const doc = state.doc;
    strip.replaceChildren(h("div", { class: "xs muted rd-empty", text: "Loading bookmarks…" }));
    const groups = [];
    for (const [src, source] of doc.sources.entries()) {
      if (!doc.pages.some((p) => p.src === src)) continue;
      const outline = await source.pdf.getOutline().catch(() => null);
      if (outline?.length) groups.push({ src, name: ctx.baseName(source.path), outline });
    }
    if (doc !== state.doc || !strip.isConnected) return;
    if (!groups.length) { strip.replaceChildren(h("div", { class: "xs muted rd-empty", text: "This PDF has no bookmarks." })); return; }
    const tree = (items, src, depth) => items.map((item) => {
      const kids = item.items?.length ? h("div", { class: "rd-kids" }, tree(item.items, src, depth + 1)) : null;
      const row = h("button", { class: "rd-bm", type: "button", title: item.title, style: `padding-left:${10 + depth * 12}px`,
        onclick: () => item.url ? followLink({ url: item.url }, null) : jumpToDest(src, item.dest) },
        h("span", { class: "ellipsis", text: item.title || "(untitled)" }));
      return h("div", {}, row, kids);
    });
    strip.replaceChildren(...groups.map((g) => h("div", { class: "rd-outline" },
      groups.length > 1 ? h("div", { class: "xs muted rd-group", text: g.name }) : null, tree(g.outline, g.src, 0))));
  }

  // ---------- Find while reading ----------

  function textOf(entry) {
    const key = `${state.doc.uid}|${entry.src}:${entry.page}`;
    if (!textCache.has(key)) {
      textCache.set(key, (async () => {
        const page = await state.doc.sources[entry.src].pdf.getPage(entry.page);
        const content = await page.getTextContent();
        let str = "";
        const pieces = [];
        for (const item of content.items) {
          if (typeof item.str !== "string") continue;
          pieces.push({ start: str.length, end: str.length + item.str.length, item, family: content.styles[item.fontName]?.fontFamily || "sans-serif" });
          str += item.str + (item.hasEOL ? " " : "");
        }
        return { str: str.toLowerCase(), pieces };
      })());
      if (textCache.size > 2000) textCache.delete(textCache.keys().next().value);
    }
    return textCache.get(key);
  }

  /** Rectangles (on-screen points of the plan page) covering characters [a, b) of a text item. */
  function itemRects(piece, a, b, viewport, crop) {
    const { item } = piece;
    const [m0, m1, m2, m3, e, f] = item.transform;
    const angle = Math.atan2(m1, m0);
    const height = item.height || Math.hypot(m2, m3) || 10;
    // Where the characters fall along the item: measured in a similar font, which follows proportional
    // spacing much better than counting characters.
    const fa = fraction(piece, a - piece.start), fb = fraction(piece, b - piece.start);
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const along = (frac, up) => [e + cos * item.width * frac - sin * height * up, f + sin * item.width * frac + cos * height * up];
    const corners = [along(fa, -0.22), along(fb, -0.22), along(fa, 0.95), along(fb, 0.95)]
      .map(([x, y]) => viewport.convertToViewportPoint(x, y));
    const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1]);
    const [t, , , l] = crop || [0, 0, 0, 0];
    return [Math.min(...xs) - l, Math.min(...ys) - t, Math.max(...xs) - l, Math.max(...ys) - t];
  }

  let measurer = null;
  function fraction(piece, chars) {
    const s = piece.item.str;
    if (chars <= 0) return 0;
    if (chars >= s.length) return 1;
    measurer ||= document.createElement("canvas").getContext("2d");
    measurer.font = `20px ${piece.family}`;
    const full = measurer.measureText(s).width;
    return full > 0 ? measurer.measureText(s.slice(0, chars)).width / full : chars / s.length;
  }

  async function search(query) {
    const doc = state.doc;
    const q = query.replace(/\s+/g, " ").trim().toLowerCase();
    find = { ...(find || {}), doc, query, matches: [], at: -1, busy: !!q };
    showFindCount();
    if (!q) { redrawFind(); return; }
    const mine = find;
    for (const [index, entry] of doc.pages.entries()) {
      if (entry.blank) continue;
      const { str, pieces } = await textOf(entry).catch(() => ({ str: "", pieces: [] }));
      if (find !== mine) return; // a newer search started
      let viewport = null;
      for (let at = str.indexOf(q); at >= 0; at = str.indexOf(q, at + q.length)) {
        viewport ||= (await viewportOf(entry, 1)).viewport;
        const end = at + q.length;
        const rects = pieces.filter((p) => p.end > at && p.start < end)
          .map((p) => itemRects(p, Math.max(at, p.start), Math.min(end, p.end), viewport, entry.crop));
        if (rects.length) mine.matches.push({ index, rects });
      }
      if (mine.matches.length && mine.at < 0) { mine.at = mine.matches.findIndex((m) => m.index >= doc.current); if (mine.at < 0) mine.at = 0; showMatch(); }
      if (index % 20 === 0) showFindCount();
    }
    mine.busy = false;
    showFindCount();
    redrawFind();
  }

  function step(direction) {
    if (!find?.matches.length) { if (find?.query) search(find.query); return; }
    find.at = (find.at + direction + find.matches.length) % find.matches.length;
    showMatch();
  }

  function showMatch() {
    const m = find?.matches[find.at];
    if (!m) return;
    const [, y0] = m.rects[0];
    const container = document.getElementById("pages");
    const slot = ctx.slots()?.[m.index];
    if (container && slot) {
      const offset = slot.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
      container.scrollTo({ top: Math.max(0, offset + y0 * state.doc.zoom - container.clientHeight / 3) });
    }
    showFindCount();
    redrawFind();
  }

  function drawFind(slot, index, zoom) {
    slot.querySelector(".rd-find")?.remove();
    if (!find || find.doc !== state.doc || !find.matches.length) return;
    const boxes = [];
    find.matches.forEach((m, k) => {
      if (m.index !== index) return;
      for (const [x0, y0, x1, y1] of m.rects) {
        boxes.push(h("div", { class: `rd-hit${k === find.at ? " cur" : ""}`, style: `left:${x0 * zoom}px;top:${y0 * zoom}px;width:${(x1 - x0) * zoom}px;height:${(y1 - y0) * zoom}px` }));
      }
    });
    if (boxes.length) slot.insertBefore(h("div", { class: "rd-find" }, boxes), slot.querySelector(".rd-layers") || slot.querySelector(".mk-layer"));
  }
  function redrawFind() {
    (ctx.slots() || []).forEach((slot, index) => { if (slot.dataset.drawn) drawFind(slot, index, state.doc.zoom); });
  }

  function showFindCount() {
    const label = document.getElementById("rd-find-count");
    if (!label || !find) return;
    const n = find.matches.length;
    label.textContent = !find.query.trim() ? "" : n ? `${find.at + 1} of ${n}${find.busy ? "+" : ""}` : find.busy ? "Searching…" : "Not found";
  }

  function findBar() {
    if (!find?.open || find.doc !== state.doc || state.doc.view !== "pages") return null;
    const input = h("input", { type: "search", id: "rd-find-input", value: find.query || "", placeholder: "Find in this PDF", "aria-label": "Find in this PDF", autocomplete: "off",
      oninput: (event) => { clearTimeout(findTimer); const value = event.target.value; findTimer = setTimeout(() => search(value), 220); },
      onkeydown: (event) => {
        if (event.key === "Enter") { event.preventDefault(); clearTimeout(findTimer); if (find.query !== event.target.value) search(event.target.value); else step(event.shiftKey ? -1 : 1); }
        else if (event.key === "Escape") { event.preventDefault(); closeFind(); }
      } });
    return h("div", { class: "rd-findbar", role: "search" }, icon("search"), input,
      h("span", { class: "xs muted rd-count", id: "rd-find-count" }),
      ctx.toolButton("chevronLeft", "Previous match (Shift+Enter)", () => step(-1)),
      ctx.toolButton("chevronRight", "Next match (Enter)", () => step(1)),
      ctx.toolButton("x", "Close (Esc)", closeFind));
  }

  function openFind() {
    if (!state.doc) return;
    if (state.doc.view !== "pages") state.doc.view = "pages";
    find = find?.doc === state.doc ? { ...find, open: true } : { doc: state.doc, query: "", matches: [], at: -1, open: true };
    const selected = String(window.getSelection?.() || "").trim();
    if (selected && selected.length < 80) find.query = selected;
    ctx.render();
    requestAnimationFrame(() => {
      const input = document.getElementById("rd-find-input");
      input?.focus(); input?.select();
      if (find.query && !find.matches.length) search(find.query); else showFindCount();
    });
  }
  function closeFind() { find = null; ctx.render(); }

  // ---------- View options ----------

  function setLayout(layout) { const doc = state.doc; read(doc).layout = layout; doc.fit = doc.fit || true; ctx.layoutPages(); }
  function turnView(quarter) { const r = read(); r.turn = ((r.turn + quarter) % 360 + 360) % 360; ctx.layoutPages(); }
  function setFit(fit) { state.doc.fit = fit; ctx.layoutPages(); }
  function toggleNight() { state.settings.night = !state.settings.night; ctx.persist(); applyNight(); ctx.render(); }
  function applyNight() { document.documentElement.dataset.night = state.settings.night ? "on" : ""; }
  async function fullScreen(on = undefined) {
    try { return await invoke("set_fullscreen", { on }); } catch (error) { toast(String(error.message || error), null, true); return false; }
  }
  function togglePanel() {
    const r = read();
    r.panel = r.panel === "bookmarks" ? "pages" : "bookmarks";
    ctx.render();
  }

  /** The "View" menu next to the zoom buttons. */
  function viewMenu(anchor) {
    document.querySelector(".rd-menu")?.remove();
    const doc = state.doc, r = read(doc);
    const item = (label, checked, run, keys = "") => h("button", { class: "rd-menu-item", type: "button", role: "menuitemcheckbox", "aria-checked": String(!!checked),
      onclick: () => { menu.remove(); run(); } }, h("span", { class: "rd-check", text: checked ? "✓" : "" }), h("span", { class: "grow", text: label }), keys ? h("span", { class: "xs muted", text: keys }) : null);
    const mod = navigator.platform.startsWith("Mac") ? "⌘" : "Ctrl+";
    const menu = h("div", { class: "rd-menu", role: "menu" },
      item("Fit width", doc.fit === true, () => setFit(true), `${mod}0`),
      item("Fit page", doc.fit === "page", () => setFit("page"), `${mod}9`),
      h("div", { class: "rd-sep" }),
      item("Single page, continuous", r.layout === "single", () => setLayout("single")),
      item("Two pages side by side", r.layout === "two", () => setLayout("two")),
      h("div", { class: "rd-sep" }),
      item("Rotate view left", false, () => turnView(-90)),
      item("Rotate view right", false, () => turnView(90)),
      item("Night reading", state.settings.night, toggleNight),
      item("Bookmarks panel", r.panel === "bookmarks", togglePanel),
      h("div", { class: "rd-sep" }),
      item("Presentation", false, present),
      item("Full screen", false, () => fullScreen()));
    document.body.append(menu);
    const box = anchor.getBoundingClientRect();
    menu.style.cssText = `top:${box.bottom + 6}px;left:${Math.min(box.left, window.innerWidth - 280)}px`;
    const away = (event) => { if (!menu.contains(event.target)) { menu.remove(); document.removeEventListener("mousedown", away, true); } };
    setTimeout(() => document.addEventListener("mousedown", away, true));
    menu.querySelector("button")?.focus();
    menu.addEventListener("keydown", (event) => { if (event.key === "Escape") { menu.remove(); anchor.focus(); } });
  }

  /** Toolbar buttons for reading, after the page and zoom controls. */
  function toolbarItems() {
    const r = read();
    return [
      withId(ctx.toolButton("back", "Back (after a link, bookmark or search)", back, { disabled: !r.back.length }), "rd-back"),
      withId(ctx.toolButton("forward", "Forward", forward, { disabled: !r.forward.length }), "rd-forward"),
      h("div", { class: "divider" }),
      ctx.toolButton("search", "Find (Ctrl+F)", openFind),
      ctx.toolButton("bookmark", "Bookmarks", togglePanel),
      withId(ctx.toolButton("eye", "View options", (event) => viewMenu(event.currentTarget)), "rd-view"),
    ];
  }
  const withId = (element, id) => { element.id = id; return element; };

  /** The left panel's switch between page thumbnails and bookmarks. */
  function panelTabs() {
    const r = read();
    const tab = (id, label) => h("button", { type: "button", class: r.panel === id ? "on" : "", text: label, onclick: () => { if (r.panel !== id) { r.panel = id; ctx.render(); } } });
    return h("div", { class: "segmented rd-panel-tabs", role: "tablist", "aria-label": "Side panel" }, tab("pages", "Pages"), tab("bookmarks", "Bookmarks"));
  }

  // ---------- Presentation: one page at a time, full screen ----------

  async function present() {
    const doc = state.doc;
    if (!doc) return;
    const wasFull = await fullScreen(true);
    let index = doc.current;
    const stage = h("div", { class: "rd-present", tabindex: "0", role: "dialog", "aria-label": "Presentation" });
    const hint = h("div", { class: "rd-present-hint xs", text: "← → to move · Esc to finish" });
    document.body.append(stage);
    const show = async () => {
      const entry = doc.pages[index];
      const [w, hgt] = ctx.shownSize(entry);
      const scale = Math.min(window.innerWidth / w, window.innerHeight / hgt);
      const canvas = await ctx.drawEntry(entry, scale);
      stage.replaceChildren(canvas, hint);
    };
    const finish = async () => {
      stage.remove();
      document.removeEventListener("keydown", onKey, true);
      if (wasFull) await fullScreen(false);
      ctx.goToPage(index);
    };
    const move = (by) => { const next = Math.min(Math.max(index + by, 0), doc.pages.length - 1); if (next !== index) { index = next; show(); } };
    const onKey = (event) => {
      const k = event.key;
      if (k === "Escape") { event.preventDefault(); event.stopPropagation(); finish(); }
      else if (["ArrowRight", "ArrowDown", "PageDown", " ", "Enter"].includes(k)) { event.preventDefault(); event.stopPropagation(); move(1); }
      else if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace"].includes(k)) { event.preventDefault(); event.stopPropagation(); move(-1); }
      else if (k === "Home") { index = 0; show(); } else if (k === "End") { index = doc.pages.length - 1; show(); }
    };
    document.addEventListener("keydown", onKey, true);
    stage.addEventListener("click", (event) => move(event.clientX < window.innerWidth / 3 ? -1 : 1));
    setTimeout(show, 250); // after the window has gone full screen
    stage.focus();
    setTimeout(() => hint.classList.add("fade"), 2500);
  }

  // ---------- Remember the open tabs ----------

  let sessionTimer = null;
  function saveSession() {
    clearTimeout(sessionTimer);
    sessionTimer = setTimeout(() => {
      try {
        if (state.settings.reopenTabs === false) { localStorage.removeItem(SESSION_KEY); return; }
        const tabs = state.docs.filter((d) => d.path && d.info && !d.info.encrypted).map((d) => ({ path: d.path, page: d.current, zoom: d.zoom, fit: d.fit }));
        localStorage.setItem(SESSION_KEY, JSON.stringify({ tabs, active: state.doc?.path || null }));
      } catch { /* not remembered this time */ }
    }, 400);
  }

  /** Reopens last session's files that still exist (they are in the recent list, which checks that). */
  async function restoreSession() {
    if (state.settings.reopenTabs === false) return;
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch { saved = null; }
    if (!saved?.tabs?.length) return;
    const known = new Set(state.recent.map((r) => r.path));
    let active = null;
    for (const tab of saved.tabs.filter((t) => known.has(t.path))) {
      const opened = await ctx.openPdf(tab.path, { quiet: true }).catch(() => false);
      if (!opened || !state.doc) continue;
      state.doc.current = Math.min(tab.page || 0, state.doc.pages.length - 1);
      if (tab.fit === false && tab.zoom) { state.doc.fit = false; state.doc.zoom = tab.zoom; } else state.doc.fit = tab.fit ?? true;
      if (tab.path === saved.active) active = state.doc;
    }
    if (active) { state.doc = active; state.section = "Document"; }
    ctx.render();
  }

  /** Commands from the Mac View menu, and the same keys on Windows. Returns true if handled. */
  function command(name) {
    if (name === "night") { toggleNight(); return true; }
    if (name === "full-screen") { fullScreen(); return true; }
    const doc = state.doc;
    if (!doc || state.section !== "Document") return false;
    const run = {
      find: openFind, "find-next": () => (find?.open ? step(1) : openFind()), "find-previous": () => (find?.open ? step(-1) : openFind()),
      "zoom-in": () => ctx.zoomBy(1), "zoom-out": () => ctx.zoomBy(-1), "fit-width": () => setFit(true), "fit-page": () => setFit("page"),
      "two-pages": () => setLayout(read().layout === "two" ? "single" : "two"),
      "rotate-view-left": () => turnView(-90), "rotate-view-right": () => turnView(90),
      bookmarks: togglePanel, back, forward, present,
    }[name];
    if (!run) return false;
    run();
    return true;
  }

  applyNight();
  return {
    decorate, findBar, openFind, closeFind, toolbarItems, panelTabs, layoutOutline, command, read,
    saveSession, restoreSession, forgetText: () => textCache.clear(), isFindOpen: () => !!find?.open && find.doc === state.doc,
  };
}
