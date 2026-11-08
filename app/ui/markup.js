// SPDX-License-Identifier: AGPL-3.0-or-later
// Mark-up (Phase 3): the tools in the "Mark up" view, the layer drawn over each page (marks, form
// fields, watermark and header/footer previews), and the sheets for stamps, watermark, header/footer
// and flattening.
//
// Marks live on the page-plan entries (entry.marks), in *visual* points: as the page is seen, after
// rotation and crop, origin top-left. So they move, duplicate and undo with their page. The worker
// writes them into the PDF on save (worker/src/aw_pdf_worker/marks.py). Form values, watermark,
// header/footer and flatten are whole-document settings on state.doc.

const COLOURS = [
  ["yellow", "Yellow", [0.957, 0.769, 0.192]],
  ["red", "Red", [0.851, 0.176, 0.125]],
  ["blue", "Blue", [0.114, 0.357, 0.749]],
  ["green", "Green", [0.075, 0.478, 0.22]],
  ["black", "Black", [0.09, 0.09, 0.09]],
];
const WIDTHS = [["1", "Thin"], ["2", "Medium"], ["4", "Thick"]];
const STAMPS = ["Reviewed", "Verified", "Approved", "Rejected", "Received", "Checked", "Copy", "Draft", "Confidential", "Original"];
const TOOLS = [
  ["select", "Select and move", "cursor"],
  ["highlight", "Highlight text", "highlighter"],
  ["underline", "Underline text", "underline"],
  ["strikeout", "Strike through text", "strike"],
  ["note", "Sticky note", "note"],
  ["text", "Add text", "textT"],
  ["ink", "Draw", "pen"],
  ["rect", "Rectangle", "square"],
  ["ellipse", "Ellipse", "circle"],
  ["line", "Line", "lineTool"],
  ["arrow", "Arrow", "arrowTool"],
  ["stamp", "Stamp", "stampTool"],
  ["image", "Picture or logo", "picture"],
  ["signature", "Signature picture", "signature"],
  ["redact", "Mark an area for redaction", "redact"],
  ["edit_text", "Edit text (beta): click a line", "textEdit"],
];
const TEXT_MARKUP = new Set(["highlight", "underline", "strikeout"]);
const BOX_MARKS = new Set(["rect", "ellipse", "text", "stamp", "image", "highlight", "underline", "strikeout", "redact"]);
const OCR_LANGUAGES = [["eng", "English"], ["asm", "Assamese"], ["ben", "Bengali"], ["hin", "Hindi"]];
const FIND_PATTERNS = [["email", "E-mail addresses"], ["phone", "Indian mobile numbers"], ["aadhaar", "Aadhaar numbers (12 digits)"], ["pan", "PAN numbers"]];
const css = (rgb) => `rgb(${rgb.map((v) => Math.round(v * 255)).join(",")})`;

export function createMarkup(ctx) {
  const { state, h, icon, invoke, worker, modal, actions, toast, edit, setDirty, plural } = ctx;
  const m = (state.markup = {
    tool: "select", colour: "red", highlightColour: "yellow", width: "2", textSize: 12,
    stamp: "Reviewed", stampDetail: true, selected: null, showComments: false, pendingImage: null,
  });
  const layers = new Map(); // page-layer cache: entry signature → Promise<{words, fields, annots}>
  let nextMarkId = 1;

  // ---------- Page layer (words, form fields, existing comments) from the worker ----------

  // Keyed by tab too: page 1 of source 0 is a different page in every open document.
  const signature = (entry) => `${state.doc.uid}|` + (entry.blank ? `blank|${entry.blank}|${entry.rotate || 0}|${entry.crop || ""}`
    : `${entry.src}|${entry.page}|${entry.rotate || 0}|${entry.crop || ""}`);
  let queue = Promise.resolve();
  function layerFor(entry) {
    const key = signature(entry);
    if (!layers.has(key)) {
      const { marks, id, ...page } = entry; // the page as it is on disk, without unsaved marks
      const job = queue.then(() => worker({ command: "page_layer", sources: ctx.sourcesForWorker(), page }))
        .catch(() => ({ words: [], fields: [], annots: [] }));
      queue = job.then(() => {}, () => {});
      layers.set(key, job);
    }
    return layers.get(key);
  }
  /** forget(uid): drop a closed tab's page layers; forget(null): only clear the selection and tool. */
  function forget(uid) {
    if (uid !== null) for (const key of [...layers.keys()]) if (key.startsWith(`${uid}|`)) layers.delete(key);
    m.selected = null;
    m.pendingImage = null;
  }

  // ---------- Geometry helpers (all in visual points) ----------

  function bbox(mark) {
    if (mark.rect) return mark.rect;
    if (mark.at) return [mark.at[0] - 9, mark.at[1] - 9, mark.at[0] + 9, mark.at[1] + 9];
    if (mark.from) return [Math.min(mark.from[0], mark.to[0]), Math.min(mark.from[1], mark.to[1]), Math.max(mark.from[0], mark.to[0]), Math.max(mark.from[1], mark.to[1])];
    const pts = (mark.paths || []).flat();
    return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
  }
  const norm = ([x0, y0, x1, y1]) => [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
  const intersects = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
  function moved(mark, dx, dy) {
    const out = structuredClone(mark);
    const shift = (p) => [p[0] + dx, p[1] + dy];
    if (out.rect) out.rect = [out.rect[0] + dx, out.rect[1] + dy, out.rect[2] + dx, out.rect[3] + dy];
    if (out.at) out.at = shift(out.at);
    if (out.from) { out.from = shift(out.from); out.to = shift(out.to); }
    if (out.paths) out.paths = out.paths.map((path) => path.map(shift));
    return out;
  }
  const colourOf = (name) => (COLOURS.find(([id]) => id === name) || COLOURS[1])[2];
  const today = () => new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });

  function addMark(entryId, mark) {
    const withId = { id: nextMarkId++, ...mark };
    edit((pages) => pages.map((p) => (p.id === entryId ? { ...p, marks: [...(p.marks || []), withId] } : p)));
    m.selected = { page: entryId, mark: withId.id };
  }
  function replaceMark(entryId, markId, change) {
    edit((pages) => pages.map((p) => (p.id === entryId
      ? { ...p, marks: (p.marks || []).map((mk) => (mk.id === markId ? change(mk) : mk)) } : p)));
  }
  function deleteSelected() {
    if (!m.selected) return false;
    const { page, mark } = m.selected;
    m.selected = null;
    edit((pages) => pages.map((p) => (p.id === page ? { ...p, marks: (p.marks || []).filter((mk) => mk.id !== mark) } : p)));
    return true;
  }

  // ---------- Sheets ----------

  function textSheet(initial = {}) {
    const area = h("textarea", { rows: "4", class: "grow", "aria-label": "Text", value: initial.text || "" });
    area.style.fontFamily = "inherit";
    area.style.fontSize = "var(--md)";
    const size = h("input", { type: "number", min: "6", max: "72", value: String(initial.size || m.textSize) });
    const bold = h("input", { type: "checkbox", checked: !!initial.bold });
    return modal((close) => [
      h("h2", { text: initial.text ? "Edit text" : "Add text" }),
      h("p", { class: "sm muted", text: "The text becomes part of the page. Assamese, Bengali, Hindi and other scripts are fine." }),
      area,
      h("div", { class: "row" }, h("label", { class: "field" }, h("span", { text: "Size (pt)" }), size), h("label", { class: "check" }, bold, "Bold")),
      actions(h("button", { class: "btn", type: "button", text: "Cancel", onclick: () => close(null) }),
        h("button", { class: "btn primary", type: "button", text: "OK", onclick: () => {
          if (!area.value.trim()) return close(null);
          m.textSize = Math.max(6, Math.min(72, Number(size.value) || 12));
          close({ text: area.value, size: m.textSize, bold: bold.checked });
        } })),
    ], { label: "Text" });
  }

  function noteSheet(initial = "") {
    const area = h("textarea", { rows: "5", class: "grow", "aria-label": "Note", value: initial });
    area.style.fontFamily = "inherit";
    return modal((close) => [
      h("h2", { text: initial ? "Edit note" : "Sticky note" }),
      area,
      actions(h("button", { class: "btn", type: "button", text: "Cancel", onclick: () => close(null) }),
        h("button", { class: "btn primary", type: "button", text: "OK", onclick: () => close(area.value.trim() || null) })),
    ], { label: "Note" });
  }

  async function chooseImage(kind) {
    let picked;
    try { picked = await invoke("pick_image"); } catch (error) { toast(String(error), null, true); return; }
    if (!picked) { m.tool = "select"; ctx.render(); return; }
    const img = new Image();
    img.src = `data:${picked.mime};base64,${picked.data}`;
    await img.decode().catch(() => {});
    m.pendingImage = { ...picked, ratio: img.naturalWidth && img.naturalHeight ? img.naturalHeight / img.naturalWidth : 0.5, kind };
    toast(kind === "signature"
      ? "Click on the page to place the signature picture. It is a picture, not a digital signature. For a valid one, use Sign with DSC."
      : "Click on the page to place the picture.");
  }

  async function watermarkSheet() {
    const doc = state.doc;
    const wm = doc.watermark || { text: "CONFIDENTIAL", color: [0.75, 0.1, 0.1], opacity: 0.18 };
    const text = h("input", { type: "text", value: wm.text || "", class: "grow" });
    const opacity = h("input", { type: "range", min: "5", max: "60", value: String(Math.round((wm.opacity || 0.18) * 100)) });
    let colour = COLOURS.find(([, , rgb]) => String(rgb) === String(wm.color))?.[0] || "red";
    const swatches = h("div", { class: "row" });
    const drawSwatches = () => swatches.replaceChildren(...COLOURS.map(([id, label, rgb]) =>
      h("button", { type: "button", class: `swatch${colour === id ? " on" : ""}`, title: label, "aria-label": label, style: `background:${css(rgb)}`,
        onclick: () => { colour = id; drawSwatches(); } })));
    drawSwatches();
    const result = await modal((close) => [
      h("h2", { text: "Watermark" }),
      h("p", { class: "sm muted", text: "Large, faint text across the middle of every page, for example COPY, DRAFT or CONFIDENTIAL. Added when you save." }),
      h("label", { class: "field" }, h("span", { text: "Text" }), text),
      h("div", { class: "row wrap" }, h("div", { class: "field" }, h("span", { text: "Colour" }), swatches),
        h("label", { class: "field grow" }, h("span", { text: "Strength" }), opacity)),
      actions(
        doc.watermark ? h("button", { class: "btn destructive", type: "button", text: "Remove watermark", onclick: () => close("remove") }) : null,
        h("button", { class: "btn", type: "button", text: "Cancel", onclick: () => close(null) }),
        h("button", { class: "btn primary", type: "button", text: "Apply", onclick: () => close(text.value.trim() ? "apply" : "remove") })),
    ], { narrow: false, label: "Watermark" });
    if (!result) return;
    doc.watermark = result === "remove" ? null : { text: text.value.trim(), color: colourOf(colour), opacity: Number(opacity.value) / 100, angle: 45 };
    setDirty(true);
    ctx.render();
  }

  async function headerFooterSheet() {
    const doc = state.doc;
    const hf = doc.headerFooter || { items: [], size: 9, margin_mm: 10, start: 1, skip_first: 0 };
    const at = (pos) => hf.items.find((i) => i.pos === pos)?.text || "";
    const field = (pos, label) => h("label", { class: "field" }, h("span", { text: label }), h("input", { type: "text", "data-pos": pos, value: at(pos) }));
    const grid = h("div", { class: "hf-grid" },
      field("top-left", "Top left"), field("top-center", "Top centre"), field("top-right", "Top right"),
      field("bottom-left", "Bottom left"), field("bottom-center", "Bottom centre"), field("bottom-right", "Bottom right"));
    const size = h("input", { type: "number", min: "5", max: "24", value: String(hf.size || 9) });
    const margin = h("input", { type: "number", min: "2", max: "60", value: String(hf.margin_mm || 10) });
    const start = h("input", { type: "number", min: "0", value: String(hf.start ?? 1) });
    const skip = h("input", { type: "checkbox", checked: !!hf.skip_first });
    const preset = (pos, text) => { grid.querySelector(`[data-pos="${pos}"]`).value = text; };
    const result = await modal((close) => [
      h("h2", { text: "Header, footer and page numbers" }),
      h("p", { class: "sm muted" }, "Text at the top or bottom of every page. Use ", h("b", { text: "{n}" }), " for the page number, ",
        h("b", { text: "{N}" }), " for the number of pages, ", h("b", { text: "{date}" }), " and ", h("b", { text: "{file}" }), "."),
      h("div", { class: "row wrap" },
        h("button", { class: "btn", type: "button", text: "Page numbers at the bottom", onclick: () => preset("bottom-center", "Page {n} of {N}") }),
        h("button", { class: "btn", type: "button", text: "File name and date at the top", onclick: () => { preset("top-left", "{file}"); preset("top-right", "{date}"); } })),
      grid,
      h("div", { class: "row wrap" },
        h("label", { class: "field" }, h("span", { text: "Size (pt)" }), size),
        h("label", { class: "field" }, h("span", { text: "Margin (mm)" }), margin),
        h("label", { class: "field" }, h("span", { text: "First number" }), start),
        h("label", { class: "check" }, skip, "Leave out the first page (cover)")),
      actions(
        doc.headerFooter ? h("button", { class: "btn destructive", type: "button", text: "Remove all", onclick: () => close("remove") }) : null,
        h("button", { class: "btn", type: "button", text: "Cancel", onclick: () => close(null) }),
        h("button", { class: "btn primary", type: "button", text: "Apply", onclick: () => close("apply") })),
    ], { narrow: false, label: "Header and footer" });
    if (!result) return;
    const items = [...grid.querySelectorAll("input")].map((i) => ({ pos: i.dataset.pos, text: i.value.trim() })).filter((i) => i.text);
    doc.headerFooter = result === "remove" || !items.length ? null : {
      items, size: Number(size.value) || 9, margin_mm: Number(margin.value) || 10, start: Number(start.value) || 0, skip_first: skip.checked ? 1 : 0 };
    setDirty(true);
    ctx.render();
  }

  async function flattenSheet() {
    const doc = state.doc;
    const box = h("input", { type: "checkbox", checked: !!doc.flatten });
    const ok = await modal((close) => [
      h("h2", { text: "Flatten" }),
      h("p", { class: "sm muted", text: "Flattening turns comments, stamps and form fields into part of the page when you save. Nobody can then move or change them, and every PDF reader shows and prints them the same way. Form fields stop being editable." }),
      h("label", { class: "check" }, box, "Flatten when saving"),
      actions(h("button", { class: "btn", type: "button", text: "Cancel", onclick: () => close(false) }),
        h("button", { class: "btn primary", type: "button", text: "OK", onclick: () => close(true) })),
    ], { label: "Flatten" });
    if (!ok) return;
    doc.flatten = box.checked;
    setDirty(true);
    ctx.render();
  }

  // ---------- Phase 4: Edit text, Find & redact, OCR ----------

  async function editLine(entry, line) {
    const input = h("input", { type: "text", class: "grow", value: line.text, "aria-label": "New text" });
    const result = await modal((close) => {
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") close(input.value); });
      return [
        h("h2", { text: "Edit text (beta)" }),
        h("p", { class: "sm muted", text: "The line is replaced in the same place, size and colour. Best for short corrections; the font is matched as closely as possible, not exactly." }),
        input,
        actions(h("button", { class: "btn", type: "button", text: "Cancel", onclick: () => close(null) }),
          h("button", { class: "btn primary", type: "button", text: "Replace", onclick: () => close(input.value) })),
      ];
    }, { label: "Edit text" });
    if (result === null || result === undefined || result === line.text) return;
    addMark(entry.id, { type: "edit_text", rect: line.rect, old: line.text, text: result, size: line.size, color: line.color,
      bold: line.bold, italic: line.italic, font: line.font });
  }

  async function findSheet() {
    const doc = state.doc;
    const terms = h("textarea", { rows: "3", class: "grow", placeholder: "Names, numbers or words, one per line" });
    terms.style.fontFamily = "inherit";
    const boxes = FIND_PATTERNS.map(([id, label]) => [id, h("input", { type: "checkbox" }), label]);
    const choice = await modal((close) => [
      h("h2", { text: "Find & redact" }),
      h("p", { class: "sm muted", text: "Finds the words and kinds of numbers you choose on every page and marks them for redaction. You can check and remove marks before saving." }),
      terms,
      h("div", { class: "stack tight" }, boxes.map(([, box, label]) => h("label", { class: "check" }, box, label))),
      h("div", { class: "xs muted", text: "Scans need OCR first (Make searchable) so their text can be found." }),
      actions(h("button", { class: "btn", type: "button", text: "Cancel", onclick: () => close(null) }),
        h("button", { class: "btn primary", type: "button", text: "Find", onclick: () => close({
          terms: terms.value.split(/\n|,/).map((t) => t.trim()).filter(Boolean),
          patterns: boxes.filter(([, box]) => box.checked).map(([id]) => id) }) })),
    ], { label: "Find & redact" });
    if (!choice || (!choice.terms.length && !choice.patterns.length)) return;
    let found;
    try {
      found = await ctx.withBusy("Searching…", () => worker({ command: "find_text", sources: ctx.sourcesForWorker(), pages: ctx.plan(), ...choice }));
    } catch (error) { toast(String(error.message || error), null, true); return; }
    if (!found.total) { toast("Nothing matching was found."); return; }
    const ids = doc.pages.map((p) => p.id);
    edit((pages) => pages.map((p, i) => {
      const hits = found.pages[ids.indexOf(p.id)] || [];
      return hits.length ? { ...p, marks: [...(p.marks || []), ...hits.map(([x0, y0, x1, y1]) => ({ id: nextMarkId++, type: "redact", rect: [x0 - 1, y0 - 1, x1 + 1, y1 + 1] }))] } : p;
    }));
    toast(`Marked ${plural(found.total, "place")} for redaction. Check them, then save.`);
  }

  async function ocrSheet() {
    const boxes = OCR_LANGUAGES.map(([id, label]) => [id, h("input", { type: "checkbox", checked: id === "eng" }), label]);
    const all = h("input", { type: "checkbox" });
    const choice = await modal((close) => [
      h("h2", { text: "Make searchable (OCR)" }),
      h("p", { class: "sm muted", text: "Reads the text in scanned pages so it can be searched, copied, highlighted and exported. Runs on this computer. The scans themselves are not changed. About a second per page." }),
      h("div", { class: "field" }, h("span", { text: "Languages in the document" }),
        h("div", { class: "row wrap" }, boxes.map(([, box, label]) => h("label", { class: "check" }, box, label)))),
      h("label", { class: "check" }, all, "Also pages that already have text"),
      h("div", { class: "xs muted", text: "Choose only the languages that appear: each extra one makes reading slower. Assamese, Bengali and Hindi are read well, but spaces between words are sometimes lost." }),
      actions(h("button", { class: "btn", type: "button", text: "Cancel", onclick: () => close(null) }),
        h("button", { class: "btn primary", type: "button", text: "Save searchable copy…", onclick: () => {
          const languages = boxes.filter(([, box]) => box.checked).map(([id]) => id);
          close({ languages: languages.length ? languages : ["eng"], all_pages: all.checked });
        } })),
    ], { label: "OCR" });
    if (!choice) return;
    ctx.saveCopy({ decorations: { ocr: choice } }, "searchable");
  }

  // ---------- Toolbar (Mark up view) ----------

  function toolbar() {
    const swatchFor = TEXT_MARKUP.has(m.tool) ? "highlightColour" : "colour";
    const showWidth = ["ink", "rect", "ellipse", "line", "arrow"].includes(m.tool);
    const btn = (iconName, label, onclick, on = false) =>
      h("button", { class: `btn icon-only${on ? " tool-on" : ""}`, type: "button", title: label, "aria-label": label, "aria-pressed": String(on), onclick }, icon(iconName));
    const tools = TOOLS.map(([id, label, iconName]) => btn(iconName, label, () => {
      m.tool = id;
      m.selected = null;
      if (id === "image" || id === "signature") chooseImage(id);
      ctx.render();
    }, m.tool === id));
    const colourRow = h("div", { class: "swatches", role: "group", "aria-label": "Colour" }, COLOURS.map(([id, label, rgb]) =>
      h("button", { type: "button", class: `swatch${m[swatchFor] === id ? " on" : ""}`, title: label, "aria-label": label, style: `background:${css(rgb)}`,
        onclick: () => { m[swatchFor] = id; ctx.render(); } })));
    const stampPick = m.tool === "stamp" ? [
      h("select", { "aria-label": "Stamp", onchange: (e) => { m.stamp = e.target.value; } },
        STAMPS.map((s) => h("option", { value: s, text: s.toUpperCase(), selected: m.stamp === s }))),
      h("label", { class: "check sm" }, h("input", { type: "checkbox", checked: m.stampDetail, onchange: (e) => { m.stampDetail = e.target.checked; } }), "Name and date"),
    ] : [];
    return h("div", { class: "actionbar markbar" },
      ctx.toolButton("undo", "Undo", ctx.undo, { disabled: !state.doc.history.length }),
      ctx.toolButton("redo", "Redo", ctx.redo, { disabled: !state.doc.future.length }),
      h("div", { class: "divider" }), tools,
      h("div", { class: "divider" }), colourRow,
      showWidth ? h("select", { "aria-label": "Line width", onchange: (e) => { m.width = e.target.value; } },
        WIDTHS.map(([v, label]) => h("option", { value: v, text: label, selected: m.width === v }))) : null,
      stampPick,
      m.selected ? ctx.toolButton("trash", "Delete the selected mark", () => deleteSelected()) : null,
      h("div", { class: "spacer" }),
      ctx.toolButton("search", "Find & redact…", findSheet),
      ctx.toolButton("ocr", "Make searchable (OCR)…", ocrSheet),
      ctx.toolButton("watermark", "Watermark…", watermarkSheet),
      ctx.toolButton("hash", "Header, footer and page numbers…", headerFooterSheet),
      ctx.toolButton("layers", "Flatten…", flattenSheet),
      h("button", { class: `btn icon-only${m.showComments ? " tool-on" : ""}`, type: "button", title: "Comments list", "aria-label": "Comments list",
        onclick: () => { m.showComments = !m.showComments; ctx.render(); } }, icon("comments")));
  }

  // ---------- The layer over each page ----------

  function fillTemplate(text, n, total) {
    return text.replace(/\{n\}/g, n).replace(/\{N\}/g, total).replace(/\{date\}/g, today()).replace(/\{file\}/g, ctx.stem(state.doc.name));
  }

  /** Builds the overlay for one page: marks, previews, form fields and the drawing surface. */
  function overlay(entry, index, zoom) {
    const doc = state.doc;
    const markupView = doc.view === "markup";
    const [w, hgt] = ctx.shownSize(entry);
    const layer = h("div", { class: `mk-layer${markupView ? ` tool-${m.tool}` : ""}`, "data-page-id": String(entry.id) });
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${w} ${hgt}`);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("class", "mk-svg");
    layer.append(svg);
    const px = (v) => `${v * zoom}px`;
    const place = (el, [x0, y0, x1, y1]) => { el.style.cssText += `;left:${px(x0)};top:${px(y0)};width:${px(x1 - x0)};height:${px(y1 - y0)}`; return el; };
    const svgEl = (tag, attrs) => {
      const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      svg.append(el);
      return el;
    };
    let words = null;
    const draw = () => {
      svg.replaceChildren();
      layer.querySelectorAll(".mk-el").forEach((el) => el.remove());
      // Previews of whole-document additions
      if (doc.watermark?.text) {
        const box = h("div", { class: "mk-el mk-watermark", text: doc.watermark.text });
        box.style.cssText = `color:${css(doc.watermark.color)};opacity:${doc.watermark.opacity};font-size:${Math.min(w, hgt) * zoom * 0.11}px`;
        layer.append(box);
      }
      if (doc.headerFooter) {
        const hf = doc.headerFooter;
        const skip = hf.skip_first || 0;
        if (index >= skip) {
          const total = doc.pages.length - skip + (hf.start ?? 1) - 1;
          const n = index - skip + (hf.start ?? 1);
          const margin = (hf.margin_mm || 10) * 72 / 25.4;
          for (const item of hf.items) {
            const [vert, horiz] = item.pos.split("-");
            const height = hf.size * 1.6;
            const y0 = vert === "top" ? margin : hgt - margin - height;
            const el = place(h("div", { class: "mk-el mk-hf", text: fillTemplate(item.text, n, total) }), [margin, y0, w - margin, y0 + height]);
            el.style.textAlign = horiz === "center" ? "center" : horiz;
            el.style.fontSize = px(hf.size);
            layer.append(el);
          }
        }
      }
      // Marks
      for (const mark of entry.marks || []) {
        const selected = m.selected && m.selected.page === entry.id && m.selected.mark === mark.id;
        const colour = css(mark.color || colourOf(mark.type === "highlight" ? "yellow" : "red"));
        const common = { "data-mark-id": String(mark.id), class: "mk-hit" };
        if (TEXT_MARKUP.has(mark.type)) {
          const boxes = (words || []).filter((wd) => intersects(wd, mark.rect)).map((wd) => wd.slice(0, 4));
          const show = boxes.length ? boxes : mark.type === "highlight" ? [mark.rect] : [];
          for (const [x0, y0, x1, y1] of show) {
            if (mark.type === "highlight") svgEl("rect", { ...common, x: x0, y: y0, width: x1 - x0, height: y1 - y0, fill: colour, "fill-opacity": 0.4 });
            else {
              const y = mark.type === "underline" ? y1 - 1 : (y0 + y1) / 2;
              svgEl("line", { ...common, x1: x0, y1: y, x2: x1, y2: y, stroke: colour, "stroke-width": 1.2 });
            }
          }
          if (!show.length) svgEl("rect", { ...common, x: mark.rect[0], y: mark.rect[1], width: mark.rect[2] - mark.rect[0], height: mark.rect[3] - mark.rect[1], fill: "transparent", stroke: colour, "stroke-dasharray": "3 2" });
        } else if (mark.type === "rect" || mark.type === "ellipse") {
          const [x0, y0, x1, y1] = mark.rect;
          if (mark.type === "rect") svgEl("rect", { ...common, x: x0, y: y0, width: x1 - x0, height: y1 - y0, fill: "transparent", stroke: colour, "stroke-width": mark.width || 2 });
          else svgEl("ellipse", { ...common, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, rx: (x1 - x0) / 2, ry: (y1 - y0) / 2, fill: "transparent", stroke: colour, "stroke-width": mark.width || 2 });
        } else if (mark.type === "line" || mark.type === "arrow") {
          svgEl("line", { ...common, x1: mark.from[0], y1: mark.from[1], x2: mark.to[0], y2: mark.to[1], stroke: colour, "stroke-width": mark.width || 2 });
          if (mark.type === "arrow") {
            const [ax, ay] = mark.to, ang = Math.atan2(mark.to[1] - mark.from[1], mark.to[0] - mark.from[0]);
            const len = 6 + 2 * (mark.width || 2), spread = 0.45;
            svgEl("polygon", { ...common, fill: colour, points: `${ax},${ay} ${ax - len * Math.cos(ang - spread)},${ay - len * Math.sin(ang - spread)} ${ax - len * Math.cos(ang + spread)},${ay - len * Math.sin(ang + spread)}` });
          }
        } else if (mark.type === "ink") {
          for (const path of mark.paths) svgEl("polyline", { ...common, points: path.map((p) => p.join(",")).join(" "), fill: "none", stroke: colour, "stroke-width": mark.width || 2, "stroke-linecap": "round", "stroke-linejoin": "round" });
        } else if (mark.type === "note") {
          const el = place(h("div", { ...common, class: "mk-el mk-hit mk-note", title: mark.text }, icon("note")), bbox(mark));
          el.style.color = colour;
          layer.append(el);
        } else if (mark.type === "text") {
          const el = place(h("div", { ...common, class: "mk-el mk-hit mk-text", text: mark.text }), mark.rect);
          el.style.color = colour;
          el.style.fontSize = px(mark.size || 12);
          el.style.fontWeight = mark.bold ? "700" : "400";
          layer.append(el);
        } else if (mark.type === "stamp") {
          const [, y0, , y1] = mark.rect;
          const el = place(h("div", { ...common, class: "mk-el mk-hit mk-stamp" },
            h("div", { class: "t", text: (mark.title || "").toUpperCase() }), mark.detail ? h("div", { class: "d", text: mark.detail }) : null), mark.rect);
          el.style.color = colour;
          el.style.borderColor = colour;
          el.querySelector(".t").style.fontSize = px((y1 - y0) * (mark.detail ? 0.36 : 0.5));
          if (mark.detail) el.querySelector(".d").style.fontSize = px((y1 - y0) * 0.17);
          layer.append(el);
        } else if (mark.type === "image") {
          layer.append(place(h("img", { ...common, class: "mk-el mk-hit mk-image", src: `data:${mark.mime || "image/png"};base64,${mark.data}`, alt: "", draggable: "false" }), mark.rect));
        } else if (mark.type === "redact") {
          layer.append(place(h("div", { ...common, class: "mk-el mk-hit mk-redact", title: "Will be blacked out and removed for good when you save" }), mark.rect));
        } else if (mark.type === "edit_text") {
          const el = place(h("div", { ...common, class: "mk-el mk-hit mk-edit", title: `Was: ${mark.old || ""}`, text: mark.text }), mark.rect);
          el.style.cssText += `;color:${css(mark.color || [0, 0, 0])};font-size:${px(mark.size || 11)};font-weight:${mark.bold ? 700 : 400};font-style:${mark.italic ? "italic" : "normal"};font-family:${mark.font === "serif" ? "Georgia, 'Times New Roman', serif" : mark.font === "mono" ? "Menlo, Consolas, monospace" : "-apple-system, 'Segoe UI', Arial, sans-serif"}`;
          layer.append(el);
        }
        if (selected) {
          const [x0, y0, x1, y1] = bbox(mark);
          const outline = place(h("div", { class: "mk-el mk-selected" }), [x0 - 3, y0 - 3, x1 + 3, y1 + 3]);
          if (BOX_MARKS.has(mark.type)) outline.append(h("div", { class: "mk-handle", "data-handle": "se" }));
          layer.append(outline);
        }
      }
    };
    // Form fields: real inputs over the page, in both Read and Mark up views.
    const drawFields = (fields) => {
      layer.querySelectorAll(".mk-field").forEach((el) => el.remove());
      for (const f of fields) {
        if (f.read_only) continue;
        const current = doc.form[f.name] ?? f.value;
        let el;
        const set = (value) => { doc.form[f.name] = value; setDirty(true); };
        if (f.type === "checkbox") {
          el = h("input", { type: "checkbox", checked: current === true || (current && current !== "Off" && current !== false), "aria-label": f.name, onchange: (e) => set(e.target.checked) });
        } else if (f.type === "radiobutton") {
          el = h("input", { type: "radio", name: `aw-${f.name}`, checked: current === f.on, "aria-label": `${f.name} ${f.on}`, onchange: () => set(f.on) });
        } else if (f.type === "combobox" || f.type === "listbox") {
          el = h("select", { "aria-label": f.name, onchange: (e) => set(e.target.value) },
            h("option", { value: "", text: "" }), (f.choices || []).map((c) => h("option", { value: c, text: c, selected: c === current })));
        } else {
          el = h("input", { type: "text", value: current ?? "", "aria-label": f.name, oninput: (e) => set(e.target.value) });
          el.style.fontSize = px(Math.max(7, Math.min(13, (f.rect[3] - f.rect[1]) * 0.6)));
        }
        el.classList.add("mk-el", "mk-field", `mk-field-${f.type}`);
        el.title = f.name;
        layer.append(place(el, f.rect));
      }
    };
    // Edit text: outline each line of text; click one to change it.
    const drawLines = (lines) => {
      if (!(markupView && m.tool === "edit_text")) return;
      const edited = new Set((entry.marks || []).filter((mk) => mk.type === "edit_text").map((mk) => mk.rect.join(",")));
      for (const line of lines) {
        if (Math.abs(line.dir[1]) > 0.01 || edited.has(line.rect.join(","))) continue; // straight lines only, once
        const el = place(h("div", { class: "mk-el mk-line", title: "Click to edit this line" }), line.rect);
        el.addEventListener("pointerdown", (e) => { e.stopPropagation(); editLine(entry, line); });
        layer.append(el);
      }
    };
    layerFor(entry).then((data) => {
      words = data.words;
      draw();
      drawFields(data.fields);
      drawLines(data.lines || []);
    });
    draw();
    if (markupView) attachTools(layer, entry, zoom);
    return layer;
  }

  // ---------- Drawing with the tools ----------

  function attachTools(layer, entry, zoom) {
    const toPoint = (e) => {
      const r = layer.getBoundingClientRect();
      return [(e.clientX - r.left) / zoom, (e.clientY - r.top) / zoom];
    };
    layer.addEventListener("pointerdown", async (e) => {
      if (e.button !== 0 || e.target.closest(".mk-field")) return;
      const start = toPoint(e);
      const tool = m.tool;
      // Select and move (also: clicking a mark with any shape tool selects it)
      const hit = e.target.closest("[data-mark-id]");
      const handle = e.target.closest(".mk-handle");
      if (tool === "select" || handle) {
        if (!hit && !handle) { if (m.selected) { m.selected = null; ctx.render(); } return; }
        const markId = handle ? m.selected.mark : Number(hit.dataset.markId);
        const mark = (entry.marks || []).find((mk) => mk.id === markId);
        if (!mark) return;
        const wasSelected = m.selected?.page === entry.id && m.selected?.mark === markId;
        m.selected = { page: entry.id, mark: markId };
        // Measured from where the drag started on screen, and nothing is redrawn until the button is
        // released: a redraw replaces this layer, and positions read from it would then be wrong.
        const startX = e.clientX, startY = e.clientY;
        let dx = 0, dy = 0, movedAny = false;
        const pieces = [...layer.querySelectorAll(`[data-mark-id="${markId}"]`), ...layer.querySelectorAll(".mk-selected")];
        const move = (ev) => {
          dx = (ev.clientX - startX) / zoom;
          dy = (ev.clientY - startY) / zoom;
          if (Math.hypot(dx, dy) * zoom > 3) movedAny = true;
          if (!handle && movedAny) {
            for (const piece of pieces) {
              if (piece instanceof SVGElement) piece.setAttribute("transform", `translate(${dx} ${dy})`);
              else piece.style.transform = `translate(${dx * zoom}px, ${dy * zoom}px)`;
            }
          }
        };
        const up = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          if (!movedAny) { if (!wasSelected) ctx.render(); return; }
          if (handle) {
            replaceMark(entry.id, markId, (mk) => {
              const [x0, y0, x1, y1] = mk.rect;
              let nx1 = Math.max(x0 + 8, x1 + dx), ny1 = Math.max(y0 + 8, y1 + dy);
              if (mk.type === "image") ny1 = y0 + (nx1 - x0) * ((y1 - y0) / (x1 - x0)); // keep the picture's shape
              return { ...mk, rect: [x0, y0, nx1, ny1] };
            });
          } else {
            replaceMark(entry.id, markId, (mk) => moved(mk, dx, dy));
          }
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
        return;
      }
      if (tool === "edit_text") return; // lines are clicked directly (drawLines)
      if (tool === "note") {
        const text = await noteSheet();
        if (text) addMark(entry.id, { type: "note", at: start, text, color: colourOf(m.colour) });
        return;
      }
      if (tool === "stamp") {
        const [w, hgt] = [180, 56];
        const detail = m.stampDetail ? [state.settings.name, today()].filter(Boolean).join(" · ") : "";
        addMark(entry.id, { type: "stamp", rect: [start[0] - w / 2, start[1] - hgt / 2, start[0] + w / 2, start[1] + hgt / 2], title: m.stamp, detail, color: colourOf(m.colour) });
        return;
      }
      if (tool === "image" || tool === "signature") {
        if (!m.pendingImage) { chooseImage(tool); return; }
        const p = m.pendingImage;
        const width = tool === "signature" ? 140 : 160;
        const height = width * p.ratio;
        addMark(entry.id, { type: "image", rect: [start[0], start[1], start[0] + width, start[1] + height], data: p.data, mime: p.mime, kind: tool });
        m.pendingImage = null;
        m.tool = "select";
        ctx.render();
        return;
      }
      // Drag tools: show a live preview, then make the mark.
      const preview = document.createElementNS("http://www.w3.org/2000/svg", tool === "ink" ? "polyline" : tool === "ellipse" ? "ellipse" : tool === "line" || tool === "arrow" ? "line" : "rect");
      const colour = css(colourOf(TEXT_MARKUP.has(tool) ? m.highlightColour : m.colour));
      preview.setAttribute("class", "mk-preview");
      preview.setAttribute("stroke", colour);
      preview.setAttribute("stroke-width", TEXT_MARKUP.has(tool) ? "0.8" : m.width);
      preview.setAttribute("fill", tool === "highlight" ? colour : "none");
      preview.setAttribute("fill-opacity", "0.35");
      layer.querySelector(".mk-svg").append(preview);
      const path = [start];
      let end = start;
      const update = () => {
        if (tool === "ink") return preview.setAttribute("points", path.map((p) => p.join(",")).join(" "));
        if (tool === "line" || tool === "arrow") {
          preview.setAttribute("x1", start[0]); preview.setAttribute("y1", start[1]);
          preview.setAttribute("x2", end[0]); preview.setAttribute("y2", end[1]);
          return;
        }
        const [x0, y0, x1, y1] = norm([...start, ...end]);
        if (tool === "ellipse") {
          preview.setAttribute("cx", (x0 + x1) / 2); preview.setAttribute("cy", (y0 + y1) / 2);
          preview.setAttribute("rx", (x1 - x0) / 2); preview.setAttribute("ry", (y1 - y0) / 2);
        } else {
          preview.setAttribute("x", x0); preview.setAttribute("y", y0);
          preview.setAttribute("width", x1 - x0); preview.setAttribute("height", y1 - y0);
        }
      };
      update();
      layer.setPointerCapture?.(e.pointerId);
      const move = (ev) => { end = toPoint(ev); if (tool === "ink") path.push(end); update(); };
      const up = async () => {
        layer.removeEventListener("pointermove", move);
        layer.removeEventListener("pointerup", up);
        preview.remove();
        const rect = norm([...start, ...end]);
        const big = rect[2] - rect[0] > 4 || rect[3] - rect[1] > 4;
        const color = colourOf(TEXT_MARKUP.has(tool) ? m.highlightColour : m.colour);
        const width = Number(m.width);
        if (TEXT_MARKUP.has(tool)) {
          if (big) addMark(entry.id, { type: tool, rect, color });
        } else if (tool === "ink") {
          if (path.length > 1) addMark(entry.id, { type: "ink", paths: [path.map((p) => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10])], color, width });
        } else if (tool === "line" || tool === "arrow") {
          if (big) addMark(entry.id, { type: tool, from: start, to: end, color, width });
        } else if (tool === "redact") {
          if (big) addMark(entry.id, { type: "redact", rect });
        } else if (tool === "rect" || tool === "ellipse") {
          if (big) addMark(entry.id, { type: tool, rect, color, width });
        } else if (tool === "text") {
          const value = await textSheet();
          if (!value) return;
          const box = big ? rect : [start[0], start[1], start[0] + Math.max(160, value.text.length * value.size * 0.55), start[1] + value.size * 1.5 * value.text.split("\n").length];
          addMark(entry.id, { type: "text", rect: box, ...value, color });
        }
      };
      layer.addEventListener("pointermove", move);
      layer.addEventListener("pointerup", up);
    });
    // Double-click a note or added text to change it.
    layer.addEventListener("dblclick", async (e) => {
      const hit = e.target.closest("[data-mark-id]");
      if (!hit) return;
      const mark = (entry.marks || []).find((mk) => mk.id === Number(hit.dataset.markId));
      if (mark?.type === "note") {
        const text = await noteSheet(mark.text);
        if (text) replaceMark(entry.id, mark.id, (mk) => ({ ...mk, text }));
      } else if (mark?.type === "text") {
        const value = await textSheet(mark);
        if (value) replaceMark(entry.id, mark.id, (mk) => ({ ...mk, ...value }));
      }
    });
  }

  // ---------- Comments list ----------

  const LABELS = { redact: "Redaction", edit_text: "Text change (beta)", highlight: "Highlight", underline: "Underline", strikeout: "Strikethrough", note: "Note", text: "Text",
    ink: "Drawing", rect: "Rectangle", ellipse: "Ellipse", line: "Line", arrow: "Arrow", stamp: "Stamp", image: "Picture" };
  function commentsPanel() {
    const doc = state.doc;
    const rows = [];
    doc.pages.forEach((entry, index) => {
      for (const mark of entry.marks || []) {
        const detail = mark.text || (mark.type === "stamp" ? `${mark.title.toUpperCase()}${mark.detail ? ` — ${mark.detail}` : ""}` : "");
        rows.push(h("button", { type: "button", class: `comment-row${m.selected?.mark === mark.id ? " on" : ""}`,
          onclick: () => { m.selected = { page: entry.id, mark: mark.id }; doc.current = index; ctx.render(); ctx.goToPage(index); } },
          h("div", { class: "xs muted", text: `Page ${index + 1} · ${LABELS[mark.type] || mark.type}${mark.kind === "signature" ? " (signature picture)" : ""}` }),
          detail ? h("div", { class: "sm", text: detail }) : null));
      }
    });
    return h("aside", { class: "comments" },
      h("div", { class: "row" }, h("h3", { text: "Your mark-up" }), h("div", { class: "spacer" }),
        h("span", { class: "xs muted", text: plural(rows.length, "item") })),
      rows.length ? rows : h("div", { class: "sm muted", text: "Nothing added yet. Pick a tool and click or drag on a page." }),
      h("div", { class: "xs muted", text: "Comments already in the PDF are shown on the pages and kept when you save." }));
  }

  function decorations() {
    const doc = state.doc;
    return { author: state.settings.name || "", file_name: ctx.stem(doc.name), form: doc.form,
      watermark: doc.watermark || null, header_footer: doc.headerFooter || null, flatten: !!doc.flatten };
  }

  function onKey(event) {
    if (state.doc?.view !== "markup") return false;
    if ((event.key === "Delete" || event.key === "Backspace") && m.selected) { event.preventDefault(); return deleteSelected(); }
    if (event.key === "Escape" && (m.selected || m.tool !== "select")) { m.selected = null; m.tool = "select"; m.pendingImage = null; ctx.render(); return true; }
    return false;
  }

  const pendingRedactions = () => state.doc.pages.reduce((n, p) => n + (p.marks || []).filter((mk) => mk.type === "redact").length, 0);

  return { toolbar, overlay, commentsPanel, decorations, onKey, forget, layerFor, pendingRedactions, ocrSheet };
}
