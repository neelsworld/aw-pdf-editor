// SPDX-License-Identifier: AGPL-3.0-or-later
// AW PDF Editor. Plain JavaScript, no framework, the same structure and look as AW Signer for Windows
// (01_AW_Signer/windows/app/ui). The Rust shell opens files and talks to the Python worker; PDF.js only
// draws pages on screen.
//
// A document is a *page plan*: a list of pages, each pointing at a page of a source PDF (with any
// added rotation and crop) or a blank page. Organise, Merge, Insert, Replace and Extract only change
// that list, so undo is a list of earlier plans. Nothing is written until Save, when the worker builds
// the new PDF from the plan (worker/src/aw_pdf_worker/pages.py).
import * as pdfjs from "./vendor/pdfjs/pdf.min.mjs";
import { icon, radio } from "./icons.js";
import { createMarkup } from "./markup.js";
import { createReader } from "./reader.js";

pdfjs.GlobalWorkerOptions.workerSrc = "./vendor/pdfjs/pdf.worker.min.mjs";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const STORE_KEY = "awpdfeditor.v1";
const SIGNER_DOWNLOAD = "https://accredworks.com/download";
const SOURCE_REPO = "github.com/neelsworld/aw-pdf-editor";
const ZOOM_STEPS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3, 4];
const MM = 72 / 25.4; // points per millimetre
const TILE_WIDTH = 150; // Organise grid thumbnails, CSS pixels

// ---------- State ----------

const saved = (() => {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || "{}"); } catch { return {}; }
})();

const state = {
  section: "Home",
  recent: [],
  docs: [],  // open documents, one per tab, in tab order
  doc: null, // the tab being shown
  error: "",
  dropActive: false,
  busy: "",
  engine: "",
  version: "",
  settings: { appearance: "system", colorTheme: "classic", ...(saved.settings || {}) },
  lastFolder: saved.lastFolder || null,
};

/* state.doc:
   { name, path (null until saved), info (worker info of the opened file, or null),
     sources: [{ path, password, pdf, sizes: [[w, h, rotate], …] }],
     pages: [{ id, src, page, rotate, crop: [t, r, b, l] | null } | { id, blank: [w, h], rotate, crop }],
     protect: { mode: "none" } | { mode: "password", open_password, permissions_password, allow_* },
     history: [], future: [], dirty, view: "pages" | "organise",
     selected: Set<id>, anchor: id | null, current: index, zoom, fit } */

function persist() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ settings: state.settings, lastFolder: state.lastFolder }));
  } catch { /* settings last this session only */ }
}

// ---------- Appearance (same switch as AW Signer) ----------

const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
function applyAppearance() {
  const s = state.settings;
  const dark = s.appearance === "dark" || (s.appearance === "system" && systemDark.matches);
  document.documentElement.dataset.mode = dark ? "dark" : "light";
  document.documentElement.dataset.accent = s.colorTheme === "blue" ? "blue" : "classic";
}
systemDark.addEventListener("change", applyAppearance);
applyAppearance();

// ---------- Small helpers ----------

/** Build an element: h("div", {class: "x", onclick: fn}, child, "text", [more]). Same as AW Signer. */
function h(tag, attrs = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") element.className = value;
    else if (key === "style") element.style.cssText = value; // through CSSOM, which the page's CSP allows
    else if (key === "text") element.textContent = value;
    else if (key.startsWith("on")) element.addEventListener(key.slice(2), value);
    else if (key === "value") element.value = value;
    else if (key === "checked") element.checked = value;
    else element.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}

const baseName = (path) => path.split(/[\\/]/).pop();
const folderOf = (path) => path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")));
const stem = (name) => name.replace(/\.pdf$/i, "");
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
function paperName([w, hgt]) {
  const mm = (p) => Math.round(p / MM);
  const [a, b] = [mm(Math.min(w, hgt)), mm(Math.max(w, hgt))];
  if (Math.abs(a - 210) <= 2 && Math.abs(b - 297) <= 2) return "A4";
  if (Math.abs(a - 216) <= 2 && Math.abs(b - 279) <= 2) return "Letter";
  if (Math.abs(a - 216) <= 2 && Math.abs(b - 356) <= 2) return "Legal";
  return `${a} × ${b} mm`;
}
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
let nextId = 1;

async function worker(request) {
  const answer = await invoke("run_worker", { request });
  if (answer.type === "error") throw new Error(answer.error);
  return answer;
}

// ---------- Modal sheets (opened only by the person, never by themselves) ----------

/** Shows a sheet. `build(close)` returns its content; resolves with what close() was given. */
function modal(build, { narrow = true, label = "" } = {}) {
  return new Promise((resolve) => {
    const previous = document.activeElement;
    const close = (value) => {
      backdrop.remove();
      document.removeEventListener("keydown", onKey, true);
      previous?.focus?.();
      resolve(value);
    };
    const onKey = (event) => { if (event.key === "Escape") { event.stopPropagation(); close(undefined); } };
    const backdrop = h("div", { class: "sheet-backdrop" },
      h("div", { class: `sheet${narrow ? " narrow" : ""}`, role: "dialog", "aria-modal": "true", "aria-label": label }, build(close)));
    document.addEventListener("keydown", onKey, true);
    document.body.append(backdrop);
    backdrop.querySelector("input, button.primary, button")?.focus();
  });
}

function actions(...buttons) { return h("div", { class: "actions" }, buttons); }
function errorLine() { return h("div", { class: "xs status-bad", "aria-live": "polite" }); }

function confirmSheet(title, text, confirmLabel, { destructive = false, cancelLabel = "Cancel" } = {}) {
  return modal((close) => [
    h("h2", { text: title }), h("p", { class: "sm muted", text }),
    actions(
      h("button", { class: "btn", type: "button", text: cancelLabel, onclick: () => close(false) }),
      h("button", { class: `btn ${destructive ? "destructive" : "primary"}`, type: "button", text: confirmLabel, onclick: () => close(true) })),
  ], { label: title });
}

function askPassword(name) {
  return modal((close) => {
    const input = h("input", { type: "password", class: "grow", "aria-label": "Password", autocomplete: "off" });
    const submit = () => close(input.value);
    input.addEventListener("keydown", (event) => { if (event.key === "Enter") submit(); });
    return [
      h("h2", { text: "This PDF is password-protected" }),
      h("p", { class: "sm muted", text: `Enter the password to open “${name}”. It is used only while the file is open and is never saved.` }),
      h("label", { class: "field" }, h("span", { text: "Password" }), input),
      actions(h("button", { class: "btn", type: "button", text: "Cancel", onclick: () => close(null) }),
        h("button", { class: "btn primary", type: "button", text: "Open", onclick: submit })),
    ];
  }, { label: "Password" });
}

/** "Working…" while the worker saves or splits. */
async function withBusy(text, task) {
  state.busy = text;
  const overlay = h("div", { class: "sheet-backdrop busy" },
    h("div", { class: "sheet narrow stack" }, h("h2", { text }), h("progress", {})));
  document.body.append(overlay);
  try { return await task(); } finally { overlay.remove(); state.busy = ""; }
}

// ---------- Loading sources ----------

const IMAGE_EXT = /\.(jpe?g|png|tiff?|bmp|gif|webp)$/i;
const OFFICE_EXT = /\.(docx?|odt|rtf|xlsx?|ods|pptx?|odp)$/i;
const LIBREOFFICE_DOWNLOAD = "https://www.libreoffice.org/download/";

/** Turns picked or dropped files ({pdfs, others}) into sources: PDFs open as they are; images, text
 *  and office files are converted first. Reports files that could not be used. In name order. */
async function loadFiles({ pdfs = [], others = [] }) {
  let pageSize = "image";
  if (others.some((p) => IMAGE_EXT.test(p))) {
    pageSize = await imageSizeSheet(others.filter((p) => IMAGE_EXT.test(p)).length);
    if (!pageSize) return [];
  }
  const items = [...pdfs.map((path) => ({ path, pdf: path })), ...others.map((path) => ({ path, pdf: null }))]
    .sort((a, b) => baseName(a.path).localeCompare(baseName(b.path), undefined, { numeric: true }));
  let failed = [];
  if (others.length) {
    const officeCount = others.filter((p) => OFFICE_EXT.test(p)).length;
    const label = officeCount ? `Converting ${plural(others.length, "file")}… Office files can take a little while.` : `Converting ${plural(others.length, "file")}…`;
    const answer = await withBusy(label, () => worker({ command: "to_pdf", inputs: others, page_size: pageSize }));
    for (const file of answer.files) items.find((item) => item.path === file.input).pdf = file.pdf;
    failed = answer.failed;
  }
  const sources = [];
  await withBusy("Opening…", async () => {
    for (const item of items.filter((i) => i.pdf)) {
      const source = await loadSource(item.pdf, item.pdf === item.path ? null : stem(baseName(item.path)).replace(/\.[^.]+$/, ""));
      if (source) sources.push(source);
    }
  });
  if (failed.length) await conversionProblems(failed);
  return sources;
}

function imageSizeSheet(count) {
  let size = "image";
  const cards = h("div", { class: "scope-cards", role: "radiogroup", "aria-label": "Page size" });
  const draw = () => cards.replaceChildren(
    radioCard("size", "image", "Same as the image", "Each page is exactly the picture", size === "image", pick),
    radioCard("size", "a4", "A4", "Fitted on A4 with a margin", size === "a4", pick),
    radioCard("size", "letter", "Letter", "Fitted on US Letter", size === "letter", pick));
  const pick = (value) => { size = value; draw(); };
  draw();
  return modal((close) => [
    h("h2", { text: count === 1 ? "Page size for the image" : `Page size for ${count} images` }),
    h("p", { class: "sm muted", text: "Photos are turned upright automatically. Landscape pictures get landscape pages." }),
    cards,
    actions(h("button", { class: "btn", type: "button", text: "Cancel", onclick: () => close(null) }),
      h("button", { class: "btn primary", type: "button", text: "Continue", onclick: () => close(size) })),
  ], { narrow: false, label: "Page size" });
}

function conversionProblems(failed) {
  const needsOffice = failed.some((f) => f.needs_office);
  return modal((close) => [
    h("h2", { text: failed.length === 1 ? "One file could not be converted" : `${failed.length} files could not be converted` }),
    h("div", { class: "card list" }, failed.map((f) =>
      h("div", { class: "file-row" }, icon("alertCircle"),
        h("div", { class: "grow" }, h("div", { class: "file-name ellipsis", text: baseName(f.input) }),
          h("div", { class: "xs muted", text: f.error }))))),
    needsOffice ? h("div", { class: "subtle-box sm" },
      "Word, Excel and PowerPoint files are converted by an office suite on this computer: Microsoft Office (Windows) or LibreOffice, which is free. ",
      "Install LibreOffice once and AW PDF Editor will use it automatically, offline.") : null,
    actions(
      needsOffice ? h("button", { class: "btn", type: "button", onclick: () => invoke("open_url", { url: LIBREOFFICE_DOWNLOAD }) }, icon("external"), "Get LibreOffice") : null,
      h("button", { class: "btn primary", type: "button", text: "OK", onclick: () => close() })),
  ], { label: "Conversion problems" });
}

/** Create PDF: pick PDFs, images, Office and text files; they become one new document in Organise. */
async function createPdf() {
  const picked = await invoke("pick_any_files");
  if (!picked.pdfs.length && !picked.others.length) return;
  await openAsNew(picked);
}

async function openAsNew(picked) {
  try {
    const sources = await loadFiles(picked);
    if (!sources.length) return;
    const pages = sources.flatMap((source, i) => pagesOf(i, source));
    const name = sources.length === 1 ? `${sources[0].title || stem(baseName(sources[0].path))}.pdf` : "Combined.pdf";
    addTab(newDoc({ name, path: null, info: null, sources, pages, view: "organise" }));
    setDirty(true);
  } catch (error) {
    state.error = String(error.message || error);
  }
  render();
}

/** Opens a PDF for display and planning: asks for its password if needed. Returns a source or null.
 *  `title`: the original file's name when the PDF was converted from another file. */
async function loadSource(path, title = null) {
  let info = await worker({ command: "info", path });
  let password = null;
  while (info.needs_password) {
    password = await askPassword(baseName(path));
    if (password === null || password === undefined) return null;
    try { info = await worker({ command: "info", path, password }); } catch (error) {
      if (!String(error.message).includes("password")) throw error;
    }
  }
  const bytes = await invoke("read_pdf", { path });
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes), password: password ?? undefined, isEvalSupported: false }).promise;
  const sizes = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const [x0, y0, x1, y1] = page.view;
    sizes.push([x1 - x0, y1 - y0, page.rotate]);
  }
  return { path, password, pdf, sizes, info, title };
}

function pagesOf(srcIndex, source) {
  return source.sizes.map((_size, i) => ({ id: nextId++, src: srcIndex, page: i + 1, rotate: 0, crop: null }));
}

let nextDocId = 1;
function newDoc({ name, path, info, sources, pages, view }) {
  const encrypted = info?.encrypted && sources[0]?.password;
  return {
    uid: nextDocId++, // keys this tab's cached page pictures and page layers
    name, path, info, sources, pages, view: view || "pages",
    protect: encrypted ? { mode: "password", open_password: sources[0].password } : { mode: "none" },
    history: [], future: [], dirty: !path, selected: new Set(), anchor: null, current: 0, zoom: 1, fit: true,
    // Phase 3, whole-document additions (applied on save): form values by field name, watermark,
    // header/footer and flatten. See markup.js.
    form: {}, watermark: null, headerFooter: null, flatten: false,
  };
}

// ---------- Tabs: every open document has one ----------

/** Shows a new document in a new tab after the current one. */
function addTab(doc) {
  const at = state.docs.indexOf(state.doc);
  state.docs.splice(at < 0 ? state.docs.length : at + 1, 0, doc);
  state.doc = doc;
  state.section = "Document";
  markup.forget(null);
  updateWindowDirty();
}

function activate(doc) {
  if (state.doc === doc && state.section === "Document") return;
  state.doc = doc;
  state.section = "Document";
  markup.forget(null); // selection and tool belong to the tab that was showing
  render();
}

/** Frees a document's PDFs and cached pictures (it is closed, or replaced by its saved file). */
function release(doc) {
  for (const source of doc.sources) source.pdf.destroy();
  for (const key of [...canvasCache.keys()]) if (key.startsWith(`${doc.uid}|`)) canvasCache.delete(key);
  markup.forget(doc.uid);
}

/** Closes a tab, asking first when it has unsaved changes. Returns false if the person cancelled. */
async function closeTab(doc = state.doc) {
  if (!doc) return true;
  if (doc.dirty) {
    activate(doc); // show the document the question is about
    if (!(await confirmDiscard())) return false;
  }
  const index = state.docs.indexOf(doc);
  if (index < 0) return true; // already closed (e.g. while the question was open)
  state.docs.splice(index, 1);
  release(doc);
  if (state.doc === doc) {
    state.doc = state.docs[Math.min(index, state.docs.length - 1)] || null;
    if (!state.doc && state.section === "Document") state.section = "Home";
  }
  updateWindowDirty();
  render();
  return true;
}

/** The saved file takes the place of the document it was saved from, in the same tab. */
function replaceTab(old, fresh) {
  const index = state.docs.indexOf(old);
  if (index >= 0) state.docs[index] = fresh; else state.docs.push(fresh);
  if (state.doc === old || !state.doc) state.doc = fresh;
  release(old);
  updateWindowDirty();
}

function updateWindowDirty() {
  invoke("set_dirty", { dirty: state.docs.some((d) => d.dirty) }).catch(() => {});
}

function renderTabs() {
  return h("div", { class: "tabbar", role: "tablist", "aria-label": "Open documents" },
    state.docs.map((doc) => {
      const on = doc === state.doc;
      return h("div", { class: `tab${on ? " on" : ""}`, role: "tab", "aria-selected": String(on), title: doc.path || "Not saved yet",
        tabindex: "0", onclick: () => activate(doc), onauxclick: (e) => { if (e.button === 1) closeTab(doc); },
        onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate(doc); } } },
        icon("fileFilled"),
        h("span", { class: "tab-name ellipsis", text: doc.name }),
        doc.dirty ? h("span", { class: "dirty-dot", title: "Unsaved changes", text: "•" }) : null,
        h("button", { class: "tab-close", type: "button", title: `Close ${doc.name}`, "aria-label": `Close ${doc.name}`,
          onclick: (e) => { e.stopPropagation(); closeTab(doc); } }, icon("x")));
    }),
    h("button", { class: "tab-new", type: "button", title: "Open another PDF", "aria-label": "Open another PDF", onclick: () => chooseFile() }, icon("plus")));
}

async function confirmDiscard() {
  if (!state.doc?.dirty) return true;
  const choice = await modal((close) => [
    h("h2", { text: "Save changes first?" }),
    h("p", { class: "sm muted", text: `“${state.doc.name}” has changes that are not saved yet.` }),
    actions(
      h("button", { class: "btn", type: "button", text: "Cancel", onclick: () => close("cancel") }),
      h("button", { class: "btn destructive", type: "button", text: "Discard changes", onclick: () => close("discard") }),
      h("button", { class: "btn primary", type: "button", text: "Save", onclick: () => close("save") })),
  ], { label: "Unsaved changes" });
  if (choice === "discard") return true;
  if (choice === "save") return await save();
  return false;
}

/** Opens a PDF in a new tab, or shows its tab if it is already open. Returns true when it is shown. */
async function openPdf(path, { view = "pages" } = {}) {
  state.error = "";
  const open = state.docs.find((d) => d.path === path);
  if (open) {
    open.view = view === "organise" ? "organise" : open.view;
    activate(open);
    return true;
  }
  let opened = false;
  try {
    const source = await withBusy("Opening…", () => loadSource(path));
    if (source) {
      addTab(newDoc({ name: baseName(path), path, info: source.info, sources: [source], pages: pagesOf(0, source), view }));
      opened = true;
      await refreshRecent();
    }
  } catch (error) {
    state.error = String(error.message || error);
    if (!state.doc) state.section = "Home";
    else toast(state.error, null, true);
  }
  render();
  return opened;
}

async function chooseFile(view = "pages") {
  const path = await invoke("pick_pdf");
  return path ? openPdf(path, { view }) : false;
}

/** Merge: pick several PDFs; they become one new, unsaved document in the Organise view. */
async function mergeFiles() {
  const paths = await invoke("pick_pdfs");
  if (!paths.length) return;
  try {
    const sources = [];
    await withBusy(`Opening ${plural(paths.length, "file")}…`, async () => {
      for (const path of paths) {
        const source = await loadSource(path);
        if (source) sources.push(source);
      }
    });
    if (!sources.length) return;
    const pages = sources.flatMap((source, i) => pagesOf(i, source));
    addTab(newDoc({ name: sources.length > 1 ? "Merged.pdf" : baseName(sources[0].path), path: null,
      info: null, sources, pages, view: "organise" }));
    setDirty(true);
  } catch (error) {
    state.error = String(error.message || error);
  }
  render();
}

async function refreshRecent() {
  try { state.recent = await invoke("recent_files"); } catch { state.recent = []; }
}

// ---------- Editing the plan (with undo) ----------

function setDirty(dirty) {
  if (state.doc) state.doc.dirty = dirty;
  updateWindowDirty(); // the window asks before closing while any tab has unsaved changes
  // Typing in a form field doesn't redraw the window: switch on Save and the dot directly.
  const saveButton = document.getElementById("save-btn");
  if (saveButton && dirty) saveButton.disabled = false;
  const tab = document.querySelector(".tab.on");
  if (tab && dirty && !tab.querySelector(".dirty-dot")) tab.querySelector(".tab-close").before(h("span", { class: "dirty-dot", title: "Unsaved changes", text: "•" }));
}

function snapshot() {
  return structuredClone(state.doc.pages); // pages with their crops and marks
}

/** Change the page list. `change(pages)` returns the new list; selection follows the given ids. */
function edit(change, { select } = {}) {
  const doc = state.doc;
  const before = snapshot();
  const after = change(snapshot());
  if (!after.length) {
    toast("A PDF needs at least one page.");
    return;
  }
  doc.history.push(before);
  if (doc.history.length > 100) doc.history.shift();
  doc.future = [];
  doc.pages = after;
  if (select) doc.selected = new Set(select);
  doc.selected = new Set([...doc.selected].filter((id) => after.some((p) => p.id === id)));
  doc.current = Math.min(doc.current, after.length - 1);
  setDirty(true);
  render();
}

function undo() {
  const doc = state.doc;
  if (!doc?.history.length) return;
  doc.future.push(snapshot());
  doc.pages = doc.history.pop();
  setDirty(true);
  render();
}

function redo() {
  const doc = state.doc;
  if (!doc?.future.length) return;
  doc.history.push(snapshot());
  doc.pages = doc.future.pop();
  setDirty(true);
  render();
}

/** The selected pages, in document order; with nothing selected, the current page. */
function targets() {
  const doc = state.doc;
  const chosen = doc.pages.filter((p) => doc.selected.has(p.id));
  return chosen.length ? chosen : doc.pages.slice(doc.current, doc.current + 1);
}

function insertIndex() {
  const doc = state.doc;
  const indexes = doc.pages.map((p, i) => (doc.selected.has(p.id) ? i : -1)).filter((i) => i >= 0);
  return indexes.length ? Math.max(...indexes) + 1 : doc.view === "pages" ? doc.current + 1 : doc.pages.length;
}

function rotateSelected(quarter) {
  const ids = new Set(targets().map((p) => p.id));
  edit((pages) => pages.map((p) => (ids.has(p.id) ? { ...p, rotate: (((p.rotate || 0) + quarter) % 360 + 360) % 360 } : p)));
}

async function deleteSelected() {
  const doc = state.doc;
  const ids = new Set(targets().map((p) => p.id));
  if (ids.size === doc.pages.length) return toast("A PDF needs at least one page. Keep at least one.");
  edit((pages) => pages.filter((p) => !ids.has(p.id)), { select: [] });
}

function duplicateSelected() {
  const chosen = targets();
  const ids = new Set(chosen.map((p) => p.id));
  const last = Math.max(...state.doc.pages.map((p, i) => (ids.has(p.id) ? i : -1)));
  const copies = chosen.map((p) => ({ ...p, id: nextId++, crop: p.crop ? [...p.crop] : null }));
  edit((pages) => [...pages.slice(0, last + 1), ...copies, ...pages.slice(last + 1)], { select: copies.map((p) => p.id) });
}

function insertBlank() {
  const doc = state.doc;
  const at = insertIndex();
  const neighbour = doc.pages[Math.max(0, at - 1)];
  const [w, hgt] = neighbour ? baseSize(neighbour) : [595.28, 841.89]; // A4
  const page = { id: nextId++, blank: [w, hgt], rotate: 0, crop: null };
  edit((pages) => [...pages.slice(0, at), page, ...pages.slice(at)], { select: [page.id] });
}

/** Adds files (PDFs, or anything Create PDF accepts) as sources; returns their indexes. */
async function addSources(picked) {
  const sources = await loadFiles(picked);
  return sources.map((source) => state.doc.sources.push(source) - 1);
}

async function addSourcesFromPicker() {
  return addSources(await invoke("pick_any_files"));
}

async function insertFromFile(picked = null) {
  const at = insertIndex();
  let added;
  try { added = picked ? await addSources(picked) : await addSourcesFromPicker(); } catch (error) {
    return toast(String(error.message || error), null, true);
  }
  if (!added.length) return;
  const newPages = added.flatMap((i) => pagesOf(i, state.doc.sources[i]));
  edit((pages) => [...pages.slice(0, at), ...newPages, ...pages.slice(at)], { select: newPages.map((p) => p.id) });
}

async function replaceSelected() {
  const chosen = targets();
  const ok = await confirmSheet("Replace pages",
    `Choose a PDF (or an image or Office file). Its first ${plural(chosen.length, "page")} will replace the ${chosen.length === 1 ? "selected page" : `${chosen.length} selected pages`}, in order.`,
    "Choose file…");
  if (!ok) return;
  const added = await addSourcesFromPicker();
  if (!added.length) return;
  const replacements = added.flatMap((i) => pagesOf(i, state.doc.sources[i])).slice(0, chosen.length);
  const map = new Map(chosen.slice(0, replacements.length).map((p, i) => [p.id, replacements[i]]));
  edit((pages) => pages.map((p) => map.get(p.id) || p), { select: replacements.map((p) => p.id) });
  if (replacements.length < chosen.length) toast(`That PDF has only ${plural(replacements.length, "page")}; the rest were left as they were.`);
}

function selectAll() {
  const doc = state.doc;
  doc.selected = new Set(doc.pages.map((p) => p.id));
  render();
}

// ---------- Page sizes and drawing ----------

/** Width and height in points as seen on screen: after rotation, before crop. */
function baseSize(entry) {
  let w, hgt, own = 0;
  if (entry.blank) [w, hgt] = entry.blank;
  else [w, hgt, own] = state.doc.sources[entry.src].sizes[entry.page - 1];
  const turn = ((own + (entry.rotate || 0)) % 360 + 360) % 360;
  return turn % 180 ? [hgt, w] : [w, hgt];
}

/** Width and height in points as seen on screen, after rotation and crop. */
function shownSize(entry) {
  const [w, hgt] = baseSize(entry);
  const [t, r, b, l] = entry.crop || [0, 0, 0, 0];
  return [Math.max(1, w - l - r), Math.max(1, hgt - t - b)];
}

/** Drawn pages, so a mark added or moved doesn't redraw every page. Keyed by what changes the
 *  picture (not by marks, which are drawn in the layer above). */
const canvasCache = new Map();
const CACHE_LIMIT = 60;
function cachedDraw(entry, scale) {
  const key = `${state.doc.uid}|${entry.blank ? `b${entry.blank}` : `${entry.src}:${entry.page}`}|${entry.rotate || 0}|${entry.crop || ""}|${scale.toFixed(4)}`;
  if (!canvasCache.has(key)) {
    canvasCache.set(key, drawEntry(entry, scale).catch((error) => { canvasCache.delete(key); throw error; }));
    if (canvasCache.size > CACHE_LIMIT) canvasCache.delete(canvasCache.keys().next().value);
  }
  return canvasCache.get(key);
}

/** Draws one plan page into a new canvas, `scale` CSS pixels per point. */
async function drawEntry(entry, scale) {
  const ratio = window.devicePixelRatio || 1;
  const [w, hgt] = shownSize(entry);
  const canvas = h("canvas", { width: Math.max(1, Math.floor(w * scale * ratio)), height: Math.max(1, Math.floor(hgt * scale * ratio)),
    style: `width:${w * scale}px;height:${hgt * scale}px` });
  const context = canvas.getContext("2d");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  if (entry.blank) return canvas;
  const page = await state.doc.sources[entry.src].pdf.getPage(entry.page);
  const viewport = page.getViewport({ scale: scale * ratio, rotation: (page.rotate + (entry.rotate || 0)) % 360 });
  const [t, , , l] = entry.crop || [0, 0, 0, 0];
  if (!entry.crop) {
    await page.render({ canvasContext: context, viewport }).promise;
    return canvas;
  }
  // Crop: draw the whole page off-screen, then copy the kept part.
  const full = document.createElement("canvas");
  full.width = Math.floor(viewport.width);
  full.height = Math.floor(viewport.height);
  await page.render({ canvasContext: full.getContext("2d"), viewport }).promise;
  context.drawImage(full, l * scale * ratio, t * scale * ratio, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
  return canvas;
}

// ---------- Sidebar ----------

const NAV = [
  ["Home", "Home", "home"],
  ["Document", "Document", "fileFilled"],
  ["Settings", "Settings", "settings"],
  ["Help", "Help & about", "help"],
];

function renderSidebar() {
  document.getElementById("nav").replaceChildren(
    ...NAV.map(([id, title, iconName]) =>
      h("button", {
        class: `nav-item${state.section === id ? " selected" : ""}`, type: "button",
        "aria-current": state.section === id ? "page" : null,
        disabled: id === "Document" && !state.doc,
        onclick: () => { state.section = id; render(); },
      }, icon(iconName), h("span", { text: id === "Document" && state.docs.length > 1 ? `Documents (${state.docs.length})` : id === "Document" && state.doc ? state.doc.name : title, class: "ellipsis" }))
    )
  );
  const footer = document.getElementById("signer-footer");
  footer.replaceChildren(icon("signature"), h("div", {},
    h("div", { class: "title", text: "Sign with DSC" }),
    h("div", { class: "sub", text: "USB token signing in AW Signer" })));
  footer.onclick = signSheet;
  document.querySelector(".version").textContent = state.version ? `Version ${state.version}` : "";
}

// ---------- Home ----------

function toolCard(iconName, title, detail, onclick) {
  return h("button", { class: "entry-card tool-card", type: "button", onclick },
    icon(iconName), h("div", { class: "title", text: title }), h("div", { class: "detail", text: detail }));
}

function renderHome() {
  const tools = h("div", { class: `entry-cards tools${state.dropActive ? " drop" : ""}` },
    toolCard("file", "Open a PDF", "Or drop files anywhere in this window", () => chooseFile()),
    toolCard("create", "Create PDF", "From Word, Excel, PowerPoint, images or text", createPdf),
    toolCard("export", "Export PDF", "To Word, Excel, PowerPoint, images or text", () => chooseFile().then((opened) => opened && exportSheet())),
    toolCard("merge", "Merge PDFs", "Combine several PDFs into one", mergeFiles),
    toolCard("split", "Split a PDF", "By page ranges, bookmarks or size", () => chooseFile("organise").then((opened) => opened && splitSheet())),
    toolCard("grid", "Organise pages", "Reorder, rotate, delete, insert", () => chooseFile("organise")),
    toolCard("redact", "Redact", "Remove private details for good", () => chooseFile("markup").then((opened) => { if (opened) { state.markup.tool = "redact"; render(); } })),
    toolCard("ocr", "Make searchable", "Read the text in scans (OCR)", () => chooseFile().then((opened) => opened && markup.ocrSheet())),
    toolCard("batch", "Batch", "Compress, OCR, number or export many PDFs", batchSheet));

  const recent = state.recent.length
    ? h("div", { class: "card list" }, state.recent.map((item) =>
        h("div", { class: "file-row" }, icon("file"),
          h("div", { class: "grow" },
            h("div", { class: "file-name ellipsis", text: item.name }),
            // Left-to-right marks keep the leading "/" in place inside the right-to-left trim.
            h("div", { class: "xs muted ellipsis head", text: `‎${item.path}‎`, title: item.path })),
          h("button", { class: "btn", type: "button", text: "Open", onclick: () => openPdf(item.path) }))))
    : h("div", { class: "subtle-box sm muted", text: "Files you open will be listed here." });

  return h("div", { class: "scroll" }, h("div", { class: "content" },
    h("div", {}, h("h1", { text: "AW PDF Editor" }),
      h("div", { class: "subtitle", text: "Free and offline. Your files never leave this computer." })),
    state.error ? h("div", { class: "banner bad" }, icon("alertCircle"), h("div", { text: state.error })) : null,
    tools,
    h("div", { class: "stack tight" }, h("h2", { text: "Recent files" }), recent),
    signerCard()));
}

/** The AW Signer card: a fixed part of the start screen (PLAN.md §6). */
function signerCard() {
  return h("div", { class: "card signer-card" }, icon("usb"),
    h("div", { class: "grow" },
      h("h2", { text: "Signing with a USB DSC token?" }),
      h("div", { class: "sm muted", text: "AW Signer adds a digital signature to your PDFs with your DSC USB token." })),
    h("button", { class: "btn primary", type: "button", text: "Sign with DSC", onclick: signSheet }));
}

// ---------- Document ----------

let viewer = null; // the open view's observers and elements

function toolButton(iconName, label, onclick, { disabled = false, text = false } = {}) {
  return h("button", { class: `btn${text ? "" : " icon-only"}`, type: "button", title: label, "aria-label": label, disabled, onclick },
    icon(iconName), text ? label : null);
}

function renderDocument() {
  const doc = state.doc;
  if (!doc) return renderHome();
  const organise = doc.view === "organise";
  const marking = doc.view === "markup";
  const total = doc.pages.length;

  const viewSwitch = h("div", { class: "segmented", role: "tablist", "aria-label": "View" },
    [["pages", "Read"], ["markup", "Mark up"], ["organise", "Organise"]].map(([id, title]) =>
      h("button", { type: "button", role: "tab", "aria-selected": String(doc.view === id), class: doc.view === id ? "on" : "", text: title,
        onclick: () => { doc.view = id; render(); } })));

  const readTools = organise ? [] : [
    h("div", { class: "divider" }),
    toolButton("chevronLeft", "Previous page", () => goToPage(doc.current - 1)),
    h("input", { type: "text", class: "page-field", id: "page-field", value: String(doc.current + 1), "aria-label": "Page number",
      onchange: (event) => goToPage(parseInt(event.target.value, 10) - 1) }),
    h("span", { class: "sm muted", text: `of ${total}` }),
    toolButton("chevronRight", "Next page", () => goToPage(doc.current + 1)),
    h("div", { class: "divider" }),
    toolButton("zoomOut", "Zoom out", () => zoomBy(-1)),
    h("span", { class: "zoom-label", id: "zoom-label" }),
    toolButton("zoomIn", "Zoom in", () => zoomBy(1)),
    toolButton("fitWidth", "Fit to width", () => { doc.fit = true; layoutPages(); }),
    doc.view === "pages" ? reader.toolbarItems() : null,
  ];

  // The file name and its unsaved dot are on the tab above, so the toolbar starts with the views.
  const toolbar = h("div", { class: "toolbar" },
    viewSwitch, readTools,
    h("div", { class: "spacer" }),
    // Labels hide on narrower windows (editor.css); the icons and tooltips stay.
    h("button", { class: "btn", type: "button", id: "save-btn", title: "Save", "aria-label": "Save", disabled: !doc.dirty && !!doc.path, onclick: save },
      icon("save"), h("span", { class: "lbl", text: "Save" })),
    h("button", { class: "btn", type: "button", title: "Save as…", "aria-label": "Save as", onclick: saveAs }, icon("duplicate"), h("span", { class: "lbl", text: "Save as…" })),
    h("button", { class: "btn", type: "button", title: "Export…", "aria-label": "Export", onclick: () => exportSheet() }, icon("export"), h("span", { class: "lbl", text: "Export…" })),
    // The one yellow button: the AW Signer hand-off (PLAN.md §6, D4).
    h("button", { class: "btn primary", type: "button", onclick: signSheet }, icon("signature"), "Sign with DSC"));

  const n = doc.selected.size;
  const actionbar = marking ? markup.toolbar() : h("div", { class: "actionbar" },
    toolButton("undo", "Undo", undo, { disabled: !doc.history.length }),
    toolButton("redo", "Redo", redo, { disabled: !doc.future.length }),
    h("div", { class: "divider" }),
    toolButton("rotateLeft", "Rotate left", () => rotateSelected(-90)),
    toolButton("rotateRight", "Rotate right", () => rotateSelected(90)),
    toolButton("trash", "Delete", deleteSelected),
    toolButton("duplicate", "Duplicate", duplicateSelected),
    toolButton("crop", "Crop margins…", cropSheet),
    h("div", { class: "divider" }),
    toolButton("insert", "Insert blank page", insertBlank),
    toolButton("merge", "Insert pages from a file…", () => insertFromFile()),
    toolButton("replace", "Replace with pages from a file…", replaceSelected),
    toolButton("extract", "Extract to a new PDF…", extractSheet),
    h("div", { class: "divider" }),
    toolButton("split", "Split…", splitSheet, { text: true }),
    toolButton("lock", "Protect…", protectSheet, { text: true }),
    toolButton("compress", "Reduce file size…", compressSheet, { text: true }),
    h("div", { class: "spacer" }),
    h("span", { class: "sm muted", text: organise
      ? (n ? `${plural(n, "page")} selected` : "Click a page to select it; drag to move")
      : `Actions apply to page ${doc.current + 1}` }),
    organise ? toolButton("selectAll", "Select all", selectAll) : null);

  const i = doc.info;
  const filesUsed = new Set(doc.pages.filter((p) => !p.blank).map((p) => p.src)).size;
  const status = h("div", { class: "statusbar" },
    h("span", { text: plural(total, "page") }),
    doc.pages[0] ? h("span", { text: paperName(shownSize(doc.pages[0])) }) : null,
    filesUsed > 1 ? h("span", { text: `From ${plural(filesUsed, "file")}` }) : null,
    i && !doc.dirty ? h("span", { text: formatSize(i.size_bytes) }) : null,
    i?.pdf_version && !doc.dirty ? h("span", { text: i.pdf_version }) : null,
    doc.protect.mode === "password" ? h("span", { class: "label" }, icon("lock"), "Password protected") : null,
    i?.has_forms ? h("span", { text: "Has form fields" }) : null,
    i?.signed ? h("span", { class: "status-warn", text: "Digitally signed: saving changes will invalidate the signature" }) : null,
    doc.watermark ? h("span", { text: `Watermark “${doc.watermark.text}”` }) : null,
    doc.headerFooter ? h("span", { text: "Header/footer" }) : null,
    doc.flatten ? h("span", { class: "status-warn", text: "Flattens on save" }) : null,
    h("div", { class: "spacer" }),
    h("span", { text: doc.dirty ? "Unsaved changes" : "Saved on this computer only" }));

  const body = organise
    ? h("div", { class: "doc-body" }, h("div", { class: "organise", id: "organise", tabindex: "-1" }, h("div", { class: "grid", id: "grid" })))
    : h("div", { class: "doc-body" },
        h("div", { class: "side-panel" }, doc.view === "pages" ? reader.panelTabs() : null, h("div", { class: "thumbs", id: "thumbs" })),
        h("div", { class: `pages${doc.view === "pages" ? " read" : ""}`, id: "pages" }, h("div", { class: "pages-inner", id: "pages-inner" })),
        reader.findBar(),
        marking && state.markup.showComments ? markup.commentsPanel() : null);

  return h("div", { class: "doc" }, renderTabs(), toolbar, actionbar, body, status);
}

// ----- Read view: continuous pages + thumbnails -----

function layoutPages() {
  const doc = state.doc;
  const container = document.getElementById("pages");
  const inner = document.getElementById("pages-inner");
  if (!doc || !container || !inner) return;
  viewer?.observer?.disconnect();
  const reading = doc.view === "pages";
  const look = reading ? reader.read(doc) : { layout: "single", turn: 0 };
  const turned = look.turn % 180 !== 0; // "Rotate view": only what's shown, never the file
  const size = (p) => { const [w, hgt] = shownSize(p); return turned ? [hgt, w] : [w, hgt]; };
  const across = reading && look.layout === "two" && doc.pages.length > 1 ? 2 : 1;
  const widest = Math.max(...doc.pages.map((p) => size(p)[0]));
  const tallest = Math.max(...doc.pages.map((p) => size(p)[1]));
  if (doc.fit) {
    const byWidth = (container.clientWidth - 64 - (across - 1) * 16) / (widest * across);
    doc.zoom = Math.max(0.25, Math.min(4, doc.fit === "page" ? Math.min(byWidth, (container.clientHeight - 48) / tallest) : byWidth));
  }
  inner.classList.toggle("two", across === 2);
  document.getElementById("zoom-label").textContent = `${Math.round(doc.zoom * 100)}%`;
  const zoom = doc.zoom;
  // Each page: its picture (from the cache), and the layer with marks and form fields on top.
  const slots = doc.pages.map((entry, index) => {
    const [w, hgt] = shownSize(entry);
    return h("div", { class: "page-slot", "data-index": String(index), style: `width:${w * zoom}px;height:${hgt * zoom}px` },
      h("div", { class: "page-canvas" }), markup.overlay(entry, index, zoom));
  });
  // Rotated view: each page sits in a box of the turned size and is turned with CSS.
  inner.replaceChildren(...(look.turn ? slots.map((slot, index) => {
    const [w, hgt] = shownSize(doc.pages[index]);
    const move = { 90: "translateY(-100%)", 180: "translate(-100%, -100%)", 270: "translateX(-100%)" }[look.turn];
    slot.style.transform = `rotate(${look.turn}deg) ${move}`;
    return h("div", { class: "turn-box", style: `width:${(turned ? hgt : w) * zoom}px;height:${(turned ? w : hgt) * zoom}px` }, slot);
  }) : slots));
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const index = Number(entry.target.dataset.index);
      if (entry.isIntersecting && !entry.target.dataset.drawn) {
        entry.target.dataset.drawn = "1";
        cachedDraw(doc.pages[index], zoom).then((canvas) => {
          entry.target.querySelector(".page-canvas").replaceChildren(canvas);
          reader.decorate(entry.target, doc.pages[index], index, zoom).catch(() => {});
        }).catch(() => {});
      }
    }
    const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (visible) setCurrentPage(Number(visible.target.dataset.index));
  }, { root: container, rootMargin: "400px 0px", threshold: [0, 0.5, 1] });
  slots.forEach((slot) => observer.observe(slot));
  viewer = { ...viewer, observer, slots, doc };
  // Keep the reading position when the view is redrawn (e.g. after adding a mark); else go to the page.
  if (keepScroll !== null) container.scrollTop = keepScroll;
  else slots[doc.current]?.scrollIntoView({ block: "start" });
  keepScroll = null;
}
let keepScroll = null;

function layoutThumbs() {
  const doc = state.doc;
  const strip = document.getElementById("thumbs");
  if (!doc || !strip) return;
  if (doc.view === "pages" && reader.read(doc).panel === "bookmarks") { reader.layoutOutline(strip); return; }
  const items = doc.pages.map((entry, index) =>
    h("button", { class: `thumb${index === doc.current ? " selected" : ""}`, type: "button", "data-index": String(index),
      "aria-label": `Page ${index + 1}`, onclick: () => goToPage(index) }, h("div", { class: "num", text: String(index + 1) })));
  strip.replaceChildren(...items);
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting || entry.target.dataset.drawn) continue;
      entry.target.dataset.drawn = "1";
      const page = doc.pages[Number(entry.target.dataset.index)];
      // A copy of the cached picture: one canvas can't be shown in two places.
      cachedDraw(page, 120 / shownSize(page)[0]).then((canvas) => {
        const copy = h("canvas", { width: canvas.width, height: canvas.height, style: canvas.style.cssText });
        copy.getContext("2d").drawImage(canvas, 0, 0);
        entry.target.prepend(copy);
      }).catch(() => {});
    }
  }, { root: strip, rootMargin: "300px 0px" });
  items.forEach((item) => observer.observe(item));
  viewer = { ...viewer, thumbObserver: observer };
}

function setCurrentPage(index) {
  const doc = state.doc;
  if (!doc || doc.current === index) return;
  doc.current = index;
  const field = document.getElementById("page-field");
  if (field && document.activeElement !== field) field.value = String(index + 1);
  document.querySelectorAll(".thumb").forEach((t) => t.classList.toggle("selected", Number(t.dataset.index) === index));
  document.querySelector(".thumb.selected")?.scrollIntoView({ block: "nearest" });
  const hint = document.querySelector(".actionbar .spacer + span");
  if (hint && doc.view === "pages") hint.textContent = `Actions apply to page ${index + 1}`;
  reader.saveSession();
}

function goToPage(index) {
  const doc = state.doc;
  if (!doc || !Number.isFinite(index)) return;
  const target = Math.min(Math.max(index, 0), doc.pages.length - 1);
  viewer?.slots?.[target]?.scrollIntoView({ block: "start", behavior: "smooth" });
  setCurrentPage(target);
  const field = document.getElementById("page-field");
  if (field) field.value = String(target + 1);
}

function zoomBy(direction) {
  const doc = state.doc;
  doc.fit = false;
  doc.zoom = direction > 0
    ? ZOOM_STEPS.find((step) => step > doc.zoom + 0.001) ?? ZOOM_STEPS.at(-1)
    : [...ZOOM_STEPS].reverse().find((step) => step < doc.zoom - 0.001) ?? ZOOM_STEPS[0];
  layoutPages();
}

// ----- Organise view: page grid with selection and drag to reorder -----

function layoutGrid() {
  const doc = state.doc;
  const grid = document.getElementById("grid");
  if (!doc || !grid) return;
  const tiles = doc.pages.map((entry, index) => {
    const [w, hgt] = shownSize(entry);
    const scale = TILE_WIDTH / Math.max(w, hgt);
    const holder = h("div", { class: "tile-page", style: `width:${w * scale}px;height:${hgt * scale}px` });
    const tile = h("div", {
      class: `tile${doc.selected.has(entry.id) ? " selected" : ""}`, role: "option", tabindex: "0",
      "aria-selected": String(doc.selected.has(entry.id)), "aria-label": `Page ${index + 1}`, "data-id": String(entry.id),
    }, h("div", { class: "tile-box" }, holder), h("div", { class: "num", text: String(index + 1) }));
    tile.addEventListener("pointerdown", (event) => startTileDrag(event, entry.id));
    tile.addEventListener("dblclick", () => { doc.current = index; doc.view = "pages"; render(); });
    tile.addEventListener("keydown", (event) => { if (event.key === " " || event.key === "Enter") { event.preventDefault(); clickTile(entry.id, event); } });
    return tile;
  });
  grid.replaceChildren(...tiles);
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting || entry.target.dataset.drawn) continue;
      entry.target.dataset.drawn = "1";
      const page = doc.pages.find((p) => String(p.id) === entry.target.dataset.id);
      const [w, hgt] = shownSize(page);
      drawEntry(page, TILE_WIDTH / Math.max(w, hgt)).then((canvas) => entry.target.querySelector(".tile-page").replaceChildren(canvas)).catch(() => {});
    }
  }, { root: document.getElementById("organise"), rootMargin: "300px 0px" });
  tiles.forEach((tile) => observer.observe(tile));
  viewer = { ...viewer, gridObserver: observer };
}

function clickTile(id, event) {
  const doc = state.doc;
  const ids = doc.pages.map((p) => p.id);
  if (event.shiftKey && doc.anchor !== null && ids.includes(doc.anchor)) {
    const [a, b] = [ids.indexOf(doc.anchor), ids.indexOf(id)].sort((x, y) => x - y);
    doc.selected = new Set(ids.slice(a, b + 1));
  } else if (event.metaKey || event.ctrlKey) {
    doc.selected.has(id) ? doc.selected.delete(id) : doc.selected.add(id);
    doc.anchor = id;
  } else {
    doc.selected = new Set([id]);
    doc.anchor = id;
  }
  doc.current = ids.indexOf(id);
  for (const tile of document.querySelectorAll(".tile")) {
    const on = doc.selected.has(Number(tile.dataset.id));
    tile.classList.toggle("selected", on);
    tile.setAttribute("aria-selected", String(on));
  }
  const hint = document.querySelector(".actionbar .spacer + span");
  if (hint) hint.textContent = doc.selected.size ? `${plural(doc.selected.size, "page")} selected` : "Click a page to select it; drag to move";
}

/** Drag to reorder with pointer events (HTML drag-and-drop clashes with file dropping on Windows). */
function startTileDrag(event, id) {
  if (event.button !== 0) return;
  const doc = state.doc;
  const startX = event.clientX, startY = event.clientY;
  let dragging = false, marker = null, dropAt = null;
  const tiles = () => [...document.querySelectorAll(".tile")];
  const move = (e) => {
    if (!dragging) {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) < 6) return;
      dragging = true;
      if (!doc.selected.has(id)) { doc.selected = new Set([id]); doc.anchor = id; }
      tiles().forEach((t) => t.classList.toggle("dragging", doc.selected.has(Number(t.dataset.id))));
      marker = h("div", { class: "drop-marker" });
      document.getElementById("grid").append(marker);
    }
    // Drop before the tile under the pointer, or after it when the pointer is on its right half.
    let best = null;
    for (const [index, tile] of tiles().entries()) {
      const r = tile.getBoundingClientRect();
      if (e.clientY >= r.top - 8 && e.clientY <= r.bottom + 8) {
        const after = e.clientX > r.left + r.width / 2;
        const distance = Math.abs(e.clientX - (after ? r.right : r.left));
        if (!best || distance < best.distance) best = { index: index + (after ? 1 : 0), tile, after, distance };
      }
    }
    if (best) {
      dropAt = best.index;
      const r = best.tile.getBoundingClientRect(), g = document.getElementById("grid").getBoundingClientRect();
      marker.style.cssText = `left:${(best.after ? r.right + 6 : r.left - 6) - g.left}px;top:${r.top - g.top}px;height:${r.height}px`;
    }
    const scroller = document.getElementById("organise").getBoundingClientRect();
    if (e.clientY < scroller.top + 40) document.getElementById("organise").scrollBy(0, -12);
    if (e.clientY > scroller.bottom - 40) document.getElementById("organise").scrollBy(0, 12);
  };
  const up = (e) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    if (!dragging) return clickTile(id, e);
    marker?.remove();
    tiles().forEach((t) => t.classList.remove("dragging"));
    if (dropAt === null) return;
    edit((pages) => {
      const moving = pages.filter((p) => doc.selected.has(p.id));
      const before = pages.slice(0, dropAt).filter((p) => !doc.selected.has(p.id));
      const after = pages.slice(dropAt).filter((p) => !doc.selected.has(p.id));
      return [...before, ...moving, ...after];
    });
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

// ---------- Saving ----------

function sourcesForWorker() {
  return state.doc.sources.map((s) => {
    const source = { path: s.path };
    if (s.password) source.password = s.password;
    if (s.title) source.title = s.title;
    return source;
  });
}

function plan(pages = state.doc.pages) {
  return pages.map((p) => {
    const out = p.blank ? { blank: p.blank } : { src: p.src, page: p.page };
    if (p.rotate) out.rotate = p.rotate;
    if (p.crop) out.crop = p.crop;
    if (p.marks?.length) out.marks = p.marks.map(({ id, ...mark }) => mark);
    return out;
  });
}

async function warnSigned() {
  if (!state.doc.info?.signed || state.doc.signWarned) return true;
  const ok = await confirmSheet("This PDF is digitally signed",
    "Saving changes to a signed PDF makes its existing digital signature invalid. Save a copy with “Save as…” to keep the signed original as it is.",
    "Save anyway", { destructive: true });
  if (ok) state.doc.signWarned = true;
  return ok;
}

/** Writes the plan to `output`, then shows the saved file. */
/** Writes the plan to `output`, then shows the saved file in the same tab. `extra`: one-off additions
 *  for this save: {decorations: {ocr, scrub}, compress: "light" | "medium" | "strong"}. */
async function writeTo(output, overwrite, extra = {}) {
  const doc = state.doc;
  const ocr = !!extra.decorations?.ocr;
  const label = ocr ? `Reading text in ${plural(doc.pages.length, "page")}… About a second per page.` : extra.compress ? "Reducing the file size…" : "Saving…";
  const before = doc.info?.size_bytes;
  const answer = await withBusy(label, () => worker({
    command: "apply_plan", sources: sourcesForWorker(), pages: plan(), output, overwrite, protect: doc.protect,
    decorations: { ...markup.decorations(), ...(extra.decorations || {}) }, compress: extra.compress || null }));
  state.lastFolder = folderOf(output);
  persist();
  // Reopen what was written, so the screen shows exactly the file on disk.
  const view = doc.view;
  const password = doc.protect.mode === "password" ? doc.protect.open_password || null : null;
  const info = await worker(password ? { command: "info", path: output, password } : { command: "info", path: output });
  const bytes = await invoke("read_pdf", { path: output });
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes), password: password || undefined, isEvalSupported: false }).promise;
  const sizes = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const [x0, y0, x1, y1] = page.view;
    sizes.push([x1 - x0, y1 - y0, page.rotate]);
  }
  const source = { path: output, password, pdf, sizes, info };
  const fresh = newDoc({ name: baseName(output), path: output, info, sources: [source], pages: pagesOf(0, source), view });
  fresh.protect = doc.protect;
  fresh.dirty = false;
  replaceTab(doc, fresh); // same tab, now showing the file on disk
  await refreshRecent();
  render();
  const notes = [];
  if (answer.redactions) notes.push(`${plural(answer.redactions, "area")} redacted and checked`);
  if (ocr) notes.push(answer.ocr_pages ? `text read on ${plural(answer.ocr_pages, "page")}` : "no scanned pages needed reading");
  if (extra.compress && before) notes.push(`${formatSize(before)} → ${formatSize(answer.size_bytes)}`);
  toast(`Saved ${baseName(output)} (${formatSize(answer.size_bytes)})${notes.length ? `: ${notes.join(", ")}` : ""}.`, output);
  return true;
}

/** Before saving redactions: say plainly that they are permanent. Returns {scrub} to go on, or null. */
async function confirmRedactions(saving_over) {
  const n = markup.pendingRedactions();
  if (!n) return {};
  const scrub = h("input", { type: "checkbox", checked: true });
  const go = await modal((close) => [
    h("h2", { text: `Redact ${plural(n, "area")} for good` }),
    h("p", { class: "sm muted", text: "Everything under the black boxes (text, parts of pictures, comments and form fields) is removed from the file, not just covered. It can't be undone after saving." }),
    saving_over ? h("div", { class: "banner warn" }, icon("warn"), h("div", { text: "You are saving over the original. Consider Save as… to keep an unredacted copy for your records." })) : null,
    h("label", { class: "check" }, scrub, "Also remove hidden information (author, title and other metadata, attachments, scripts)"),
    actions(h("button", { class: "btn", type: "button", text: "Cancel", onclick: () => close(false) }),
      h("button", { class: "btn destructive", type: "button", text: "Redact and save", onclick: () => close(true) })),
  ], { label: "Redact" });
  return go ? { decorations: scrub.checked ? { scrub: true } : {} } : null;
}

/** Saves a changed copy (searchable, smaller…) under a new name and shows it in this tab. */
async function saveCopy(extra, suffix) {
  const doc = state.doc;
  if (!doc) return false;
  const output = await invoke("pick_save_path", { suggested: `${stem(doc.name)} (${suffix}).pdf`, folder: doc.path ? folderOf(doc.path) : state.lastFolder });
  if (!output) return false;
  const redactions = await confirmRedactions(false);
  if (!redactions) return false;
  const merged = { ...extra, decorations: { ...(extra.decorations || {}), ...(redactions.decorations || {}) } };
  try { return await writeTo(output, true, merged); } catch (error) { toast(String(error.message || error), null, true); return false; }
}

async function save() {
  const doc = state.doc;
  if (!doc) return false;
  if (!doc.path) return saveAs(); // a merged document has never been saved
  if (!(await warnSigned())) return false;
  const extra = await confirmRedactions(true);
  if (!extra) return false;
  try { return await writeTo(doc.path, true, extra); } catch (error) { toast(String(error.message || error), null, true); return false; }
}

async function saveAs() {
  const doc = state.doc;
  if (!doc) return false;
  const suggested = doc.path ? `${stem(doc.name)} (edited).pdf` : doc.name;
  const output = await invoke("pick_save_path", { suggested, folder: doc.path ? folderOf(doc.path) : state.lastFolder });
  if (!output) return false;
  const extra = await confirmRedactions(false);
  if (!extra) return false;
  try { return await writeTo(output, true, extra); } catch (error) { toast(String(error.message || error), null, true); return false; }
}

// ---------- Reduce file size ----------

const SQUEEZE = [
  ["light", "Tidy only", "No change to pictures; drops leftovers and packs the file"],
  ["medium", "Balanced", "Pictures above 225 dpi down to 150 dpi. Good for e-mail and portals"],
  ["strong", "Smallest", "Pictures down to 100 dpi; fonts trimmed. For upload size limits"],
];

async function compressSheet() {
  let level = "medium";
  const cards = h("div", { class: "scope-cards" });
  const draw = () => cards.replaceChildren(...SQUEEZE.map(([id, title, text]) => radioCard("squeeze", id, title, text, level === id, (v) => { level = v; draw(); })));
  draw();
  const ok = await modal((close) => [
    h("h2", { text: "Reduce file size" }),
    h("p", { class: "sm muted", text: "Saves a smaller copy. The original stays as it is. Text stays sharp at every level; only pictures and scans get lighter." }),
    cards,
    actions(h("button", { class: "btn", type: "button", text: "Cancel", onclick: () => close(false) }),
      h("button", { class: "btn primary", type: "button", text: "Save smaller copy…", onclick: () => close(true) })),
  ], { narrow: false, label: "Reduce file size" });
  if (ok) await saveCopy({ compress: level }, "smaller");
}

// ---------- Batch: one action on many files ----------

const BATCH = [
  ["compress", "Reduce size", "Balanced compression"],
  ["ocr", "Make searchable", "OCR scanned pages"],
  ["numbers", "Page numbers", "“Page n of N” at the bottom"],
  ["watermark", "Watermark", "Text across every page"],
  ["docx", "Export to Word", ".docx next to each"],
  ["txt", "Export to text", ".txt next to each"],
];

async function batchSheet() {
  let action = "compress";
  const watermark = h("input", { type: "text", value: "COPY" });
  const langs = OCR_CHOICES.map(([id, label]) => [id, h("input", { type: "checkbox", checked: id === "eng" }), label]);
  const cards = h("div", { class: "scope-cards export-cards" });
  const detail = h("div", { class: "stack tight" });
  const draw = () => {
    cards.replaceChildren(...BATCH.map(([id, title, text]) => radioCard("batch", id, title, text, action === id, (v) => { action = v; draw(); })));
    detail.replaceChildren(...[
      action === "watermark" ? h("label", { class: "field" }, h("span", { text: "Watermark text" }), watermark) : null,
      action === "ocr" ? h("div", { class: "row wrap" }, langs.map(([, box, label]) => h("label", { class: "check" }, box, label))) : null,
    ].filter(Boolean));
  };
  draw();
  const ok = await modal((close) => [
    h("h2", { text: "Batch" }),
    h("p", { class: "sm muted", text: "Do one thing to many PDFs at once. The results go into a folder you choose; the originals are not changed and no file there is replaced." }),
    cards, detail,
    actions(h("button", { class: "btn", type: "button", text: "Cancel", onclick: () => close(false) }),
      h("button", { class: "btn primary", type: "button", text: "Choose PDFs…", onclick: () => close(true) })),
  ], { narrow: false, label: "Batch" });
  if (!ok) return;
  const files = await invoke("pick_pdfs");
  if (!files.length) return;
  const folder = await invoke("pick_folder", { folder: state.lastFolder });
  if (!folder) return;
  state.lastFolder = folder;
  persist();
  const languages = langs.filter(([, box]) => box.checked).map(([id]) => id);
  const suffix = { compress: "smaller", ocr: "searchable", numbers: "numbered", watermark: "watermarked" }[action];
  const results = [];
  const overlay = h("div", { class: "sheet-backdrop busy" }, h("div", { class: "sheet narrow stack" }, h("h2", { id: "batch-progress" }), h("progress", {})));
  document.body.append(overlay);
  try {
    for (const [index, path] of files.entries()) {
      overlay.querySelector("#batch-progress").textContent = `${index + 1} of ${files.length}: ${baseName(path)}`;
      try {
        const info = await worker({ command: "info", path });
        if (info.needs_password) throw new Error("Password-protected: open it on its own to process it.");
        const pages = Array.from({ length: info.pages }, (_v, i) => ({ src: 0, page: i + 1 }));
        const base = stem(baseName(path));
        const join = (name) => `${folder}${folder.includes("\\") ? "\\" : "/"}${name}`;
        let answer;
        if (action === "docx" || action === "txt") {
          answer = await worker({ command: "export", format: action, sources: [{ path }], pages, output: join(`${base}.${action}`), unique: true, base_name: base });
          results.push({ path, out: answer.files[0].path });
        } else {
          const decorations = action === "ocr" ? { ocr: { languages: languages.length ? languages : ["eng"] } }
            : action === "numbers" ? { header_footer: { items: [{ pos: "bottom-center", text: "Page {n} of {N}" }], size: 9, margin_mm: 10, start: 1 } }
            : action === "watermark" ? { watermark: { text: watermark.value.trim() || "COPY", color: [0.75, 0.1, 0.1], opacity: 0.18, angle: 45 } } : {};
          answer = await worker({ command: "apply_plan", sources: [{ path }], pages, output: join(`${base} (${suffix}).pdf`), overwrite: false, unique: true,
            decorations, compress: action === "compress" ? "medium" : null });
          results.push({ path, out: answer.path, note: action === "compress" ? `${formatSize(info.size_bytes)} → ${formatSize(answer.size_bytes)}` : "" });
        }
      } catch (error) {
        results.push({ path, error: String(error.message || error) });
      }
    }
  } finally {
    overlay.remove();
  }
  const done = results.filter((r) => !r.error).length;
  await modal((close) => [
    h("h2", { text: `Done: ${done} of ${plural(files.length, "file")}` }),
    h("div", { class: "card list split-results" }, results.map((r) =>
      h("div", { class: "file-row" }, icon(r.error ? "alertCircle" : "checkCircle"),
        h("div", { class: "grow" }, h("div", { class: "file-name ellipsis", text: baseName(r.error ? r.path : r.out) }),
          h("div", { class: `xs ${r.error ? "status-bad" : "muted"}`, text: r.error || r.note || "" }))))),
    actions(h("button", { class: "btn", type: "button", text: "Show in folder", onclick: () => invoke("reveal", { path: folder }) }),
      h("button", { class: "btn primary", type: "button", text: "Done", onclick: () => close() })),
  ], { label: "Batch finished" });
}
const OCR_CHOICES = [["eng", "English"], ["asm", "Assamese"], ["ben", "Bengali"], ["hin", "Hindi"]];

// ---------- Sheets: extract, crop, split, protect ----------

async function extractSheet() {
  const doc = state.doc;
  const chosen = targets();
  const remove = h("input", { type: "checkbox" });
  const ok = await modal((close) => [
    h("h2", { text: "Extract pages" }),
    h("p", { class: "sm muted", text: `Save ${chosen.length === 1 ? `page ${doc.pages.indexOf(chosen[0]) + 1}` : `the ${chosen.length} selected pages`} as a new PDF. ${doc.view === "organise" ? "" : "Tip: select several pages in Organise first."}` }),
    h("label", { class: "check" }, remove, "Also delete them from this document"),
    actions(h("button", { class: "btn", type: "button", text: "Cancel", onclick: () => close(false) }),
      h("button", { class: "btn primary", type: "button", text: "Save as…", onclick: () => close(true) })),
  ], { label: "Extract pages" });
  if (!ok) return;
  const output = await invoke("pick_save_path", { suggested: `${stem(doc.name)} (pages).pdf`, folder: doc.path ? folderOf(doc.path) : state.lastFolder });
  if (!output) return;
  try {
    await withBusy("Saving…", () => worker({ command: "apply_plan", sources: sourcesForWorker(), pages: plan(chosen), output, overwrite: true, protect: doc.protect, decorations: markup.decorations() }));
    if (remove.checked && chosen.length < doc.pages.length) {
      const ids = new Set(chosen.map((p) => p.id));
      edit((pages) => pages.filter((p) => !ids.has(p.id)), { select: [] });
    }
    toast(`Saved ${plural(chosen.length, "page")} to ${baseName(output)}.`, output);
  } catch (error) { toast(String(error.message || error), null, true); }
}

async function cropSheet() {
  const chosen = targets();
  const first = chosen[0];
  const [w, hgt] = baseSize(first);
  const current = (first.crop || [0, 0, 0, 0]).map((v) => Math.round(v / MM));
  const fields = ["Top", "Right", "Bottom", "Left"].map((label, i) =>
    h("label", { class: "field" }, h("span", { text: `${label} (mm)` }),
      h("input", { type: "number", min: "0", step: "1", value: String(current[i]), "data-edge": String(i) })));
  const err = errorLine();
  const margins = await modal((close) => [
    h("h2", { text: "Crop margins" }),
    h("p", { class: "sm muted", text: `Trim the edges of ${chosen.length === 1 ? "this page" : `the ${chosen.length} selected pages`}, as they look on screen. The page is ${Math.round(w / MM)} × ${Math.round(hgt / MM)} mm. Set all to 0 to remove a crop.` }),
    h("div", { class: "crop-grid" }, fields),
    err,
    actions(h("button", { class: "btn", type: "button", text: "Cancel", onclick: () => close(null) }),
      h("button", { class: "btn primary", type: "button", text: "Crop", onclick: () => {
        const values = fields.map((f) => Number(f.querySelector("input").value));
        if (values.some((v) => !Number.isFinite(v) || v < 0)) { err.textContent = "Use numbers of 0 or more."; return; }
        const pts = values.map((v) => v * MM);
        const tooBig = chosen.some((p) => { const [pw, ph] = baseSize(p); return pw - pts[1] - pts[3] < 36 || ph - pts[0] - pts[2] < 36; });
        if (tooBig) { err.textContent = "Those margins are larger than the page."; return; }
        close(pts);
      } })),
  ], { label: "Crop margins" });
  if (!margins) return;
  const ids = new Set(chosen.map((p) => p.id));
  const crop = margins.some((v) => v > 0) ? margins : null;
  edit((pages) => pages.map((p) => (ids.has(p.id) ? { ...p, crop } : p)));
}

function radioCard(group, value, title, detail, selected, onSelect) {
  return h("div", {
    class: `scope-card${selected ? " selected" : ""}`, role: "radio", tabindex: "0", "aria-checked": String(selected),
    "data-group": group, "data-value": value,
    onclick: (event) => { if (event.target.tagName !== "INPUT") onSelect(value); },
    onkeydown: (event) => { if (event.key === " " || event.key === "Enter") { event.preventDefault(); onSelect(value); } },
  }, h("div", { class: "icons" }, radio(selected)), h("div", { class: "title", text: title }), h("div", { class: "detail", text: detail }));
}

function parseRanges(text, count) {
  const ranges = [];
  for (const part of text.split(/[,;]+/).map((s) => s.trim()).filter(Boolean)) {
    const match = part.match(/^(\d+)\s*(?:[-–]\s*(\d+))?$/);
    if (!match) throw new Error(`“${part}” is not a page range. Use for example 1-3, 4-10.`);
    const a = Number(match[1]), b = Number(match[2] ?? match[1]);
    if (a < 1 || b < a || b > count) throw new Error(`${part} is outside pages 1–${count}.`);
    ranges.push([a, b]);
  }
  if (!ranges.length) throw new Error("Enter at least one page range, for example 1-3, 4-10.");
  return ranges;
}

async function splitSheet() {
  const doc = state.doc;
  const count = doc.pages.length;
  let kind = "every";
  const rangesInput = h("input", { type: "text", placeholder: "1-3, 4-10", class: "grow" });
  const everyInput = h("input", { type: "number", min: "1", value: String(Math.min(10, Math.max(1, Math.ceil(count / 2)))) });
  const sizeInput = h("input", { type: "number", min: "0.1", step: "0.5", value: "5" });
  const hasBookmarks = doc.sources.some((s) => s.info?.top_bookmarks > 0);
  const err = errorLine();
  const cards = h("div", { class: "scope-cards split-cards", role: "radiogroup", "aria-label": "How to split" });
  const detail = h("div", { class: "stack tight" });
  const draw = () => {
    // filter(Boolean): replaceChildren would show a skipped (null) choice as the text "null".
    cards.replaceChildren(...[
      radioCard("split", "every", "Every N pages", "Equal parts", kind === "every", pick),
      radioCard("split", "ranges", "Page ranges", "You list them", kind === "ranges", pick),
      hasBookmarks ? radioCard("split", "bookmarks", "Bookmarks", "One part per top bookmark", kind === "bookmarks", pick) : null,
      radioCard("split", "size", "File size", "Parts under a size", kind === "size", pick)].filter(Boolean));
    detail.replaceChildren(...[
      kind === "every" ? h("label", { class: "field" }, h("span", { text: `Pages per part (this document has ${count})` }), everyInput) : null,
      kind === "ranges" ? h("label", { class: "field" }, h("span", { text: "Page ranges, separated by commas" }), rangesInput) : null,
      kind === "bookmarks" ? h("div", { class: "sm muted", text: "Each top-level bookmark starts a new part, named after the bookmark." }) : null,
      kind === "size" ? h("label", { class: "field" }, h("span", { text: "Largest size per part (MB)" }), sizeInput) : null].filter(Boolean));
  };
  const pick = (value) => { kind = value; err.textContent = ""; draw(); };
  draw();
  const mode = await modal((close) => [
    h("h2", { text: "Split into several PDFs" }),
    h("p", { class: "sm muted", text: "The parts are saved as new files in a folder you choose. This document is not changed." }),
    cards, detail, err,
    actions(h("button", { class: "btn", type: "button", text: "Cancel", onclick: () => close(null) }),
      h("button", { class: "btn primary", type: "button", text: "Choose folder…", onclick: () => {
        try {
          if (kind === "ranges") close({ kind, ranges: parseRanges(rangesInput.value, count) });
          else if (kind === "every") {
            const n = parseInt(everyInput.value, 10);
            if (!(n >= 1)) throw new Error("Enter how many pages each part should have.");
            close({ kind, pages: n });
          } else if (kind === "size") {
            const mb = Number(sizeInput.value);
            if (!(mb >= 0.01)) throw new Error("Enter a size of at least 0.01 MB.");
            close({ kind, max_bytes: Math.round(mb * 1024 * 1024) });
          } else close({ kind });
        } catch (error) { err.textContent = error.message; }
      } })),
  ], { narrow: false, label: "Split" });
  if (!mode) return;
  const folder = await invoke("pick_folder", { folder: doc.path ? folderOf(doc.path) : state.lastFolder });
  if (!folder) return;
  try {
    const answer = await withBusy("Splitting…", () => worker({
      command: "split", sources: sourcesForWorker(), pages: plan(), folder, base_name: stem(doc.name), mode, protect: doc.protect, decorations: markup.decorations() }));
    state.lastFolder = folder;
    persist();
    await modal((close) => [
      h("h2", { text: `Saved ${plural(answer.files.length, "part")}` }),
      h("div", { class: "card list split-results" }, answer.files.map((f) =>
        h("div", { class: "file-row" }, icon("file"),
          h("div", { class: "grow" }, h("div", { class: "file-name ellipsis", text: baseName(f.path) }),
            h("div", { class: "xs muted", text: `${f.first_page === f.last_page ? `Page ${f.first_page}` : `Pages ${f.first_page}–${f.last_page}`} · ${formatSize(f.size_bytes)}` }))))),
      actions(h("button", { class: "btn", type: "button", text: "Show in folder", onclick: () => invoke("reveal", { path: folder }) }),
        h("button", { class: "btn primary", type: "button", text: "Done", onclick: () => close() })),
    ], { label: "Split finished" });
  } catch (error) { toast(String(error.message || error), null, true); }
}

// ---------- Export ----------

const EXPORTS = [
  ["docx", "Word", "Editable document (.docx)"],
  ["xlsx", "Excel", "Tables into sheets (.xlsx)"],
  ["pptx", "PowerPoint", "A slide per page (.pptx)"],
  ["image", "Images", "PNG, JPEG or TIFF"],
  ["txt", "Text", "Plain text (.txt)"],
  ["html", "Web page", "One HTML file (.html)"],
  ["md", "Markdown", "Headings and tables (.md)"],
];

async function exportSheet() {
  const doc = state.doc;
  if (!doc) return;
  let format = state.lastExport || "docx", imageType = "png", dpi = "150";
  const selectedPages = doc.pages.filter((p) => doc.selected.has(p.id));
  let scope = doc.view === "organise" && selectedPages.length ? "selected" : "all";
  const cards = h("div", { class: "scope-cards export-cards", role: "radiogroup", "aria-label": "Format" });
  const detail = h("div", { class: "stack tight" });
  const err = errorLine();
  const draw = () => {
    cards.replaceChildren(...EXPORTS.map(([id, title, text]) => radioCard("format", id, title, text, format === id, (v) => { format = v; draw(); })));
    detail.replaceChildren(...[
      format === "image" ? h("div", { class: "row wrap" },
        h("div", { class: "field" }, h("span", { text: "Image type" }),
          segmented([["png", "PNG"], ["jpeg", "JPEG"], ["tiff", "TIFF (one file)"]], imageType, (v) => { imageType = v; draw(); })),
        h("div", { class: "field" }, h("span", { text: "Resolution" }),
          segmented([["72", "72 dpi"], ["150", "150 dpi"], ["300", "300 dpi"], ["600", "600 dpi"]], dpi, (v) => { dpi = v; draw(); })))
        : null,
      format === "docx" ? h("div", { class: "xs muted", text: "Works best for normal text documents and simple tables. Complex layouts may need tidying in Word. Beta." }) : null,
      format === "xlsx" ? h("div", { class: "xs muted", text: "Each table found becomes a sheet; numbers stay numbers. With no tables, the text goes in one column." }) : null,
      format === "pptx" ? h("div", { class: "xs muted", text: "Each page becomes a slide: pictures and lines as the background, text as editable text boxes." }) : null,
      h("div", { class: "field" }, h("span", { text: "Pages" }),
        segmented([["all", `All ${doc.pages.length} pages`],
          ...(selectedPages.length ? [["selected", `${plural(selectedPages.length, "selected page")}`]] : []),
          ...(doc.view === "pages" ? [["current", `Page ${doc.current + 1}`]] : [])], scope, (v) => { scope = v; draw(); })),
    ].filter(Boolean));
  };
  draw();
  const ok = await modal((close) => [
    h("h2", { text: "Export PDF" }),
    h("p", { class: "sm muted", text: "Saves a copy in another format. Unsaved changes are included; this PDF is not changed." }),
    cards, detail, err,
    actions(h("button", { class: "btn", type: "button", text: "Cancel", onclick: () => close(false) }),
      h("button", { class: "btn primary", type: "button", text: "Export…", onclick: () => close(true) })),
  ], { narrow: false, label: "Export PDF" });
  if (!ok) return;
  state.lastExport = format;
  const pages = scope === "selected" ? selectedPages : scope === "current" ? doc.pages.slice(doc.current, doc.current + 1) : doc.pages;
  const fmt = format === "image" ? imageType : format;
  const ext = { docx: "docx", xlsx: "xlsx", pptx: "pptx", png: "png", jpeg: "jpg", tiff: "tiff", txt: "txt", html: "html", md: "md" }[fmt];
  const base = stem(doc.name);
  const folderHint = doc.path ? folderOf(doc.path) : state.lastFolder;
  const request = { command: "export", format: fmt, sources: sourcesForWorker(), pages: plan(pages), base_name: base, dpi: Number(dpi), decorations: markup.decorations() };
  if ((fmt === "png" || fmt === "jpeg") && pages.length > 1) {
    request.folder = await invoke("pick_folder", { folder: folderHint });
    if (!request.folder) return;
  } else {
    request.output = await invoke("pick_save_path", { suggested: `${base}.${ext}`, folder: folderHint, format: fmt });
    if (!request.output) return;
  }
  try {
    const label = fmt === "docx" ? "Exporting to Word… This can take a while for long documents." : "Exporting…";
    const answer = await withBusy(label, () => worker(request));
    state.lastFolder = request.folder || folderOf(request.output);
    persist();
    const first = answer.files[0]?.path;
    const what = answer.files.length > 1 ? `${answer.files.length} files` : baseName(first);
    if (answer.warnings.length) {
      await modal((close) => [
        h("h2", { text: `Exported ${what}` }),
        ...answer.warnings.map((w) => h("div", { class: "banner warn" }, icon("warn"), h("div", { text: w }))),
        actions(h("button", { class: "btn", type: "button", text: "Show in folder", onclick: () => invoke("reveal", { path: first }) }),
          h("button", { class: "btn primary", type: "button", text: "OK", onclick: () => close() })),
      ], { label: "Export finished" });
    } else {
      toast(`Exported ${what}.`, first);
    }
  } catch (error) { toast(String(error.message || error), null, true); }
}

async function protectSheet() {
  const doc = state.doc;
  const p = doc.protect;
  let mode = p.mode;
  const openPw = h("input", { type: "password", autocomplete: "new-password", value: p.open_password || "" });
  const openPw2 = h("input", { type: "password", autocomplete: "new-password", value: p.open_password || "" });
  const restrict = h("input", { type: "checkbox", checked: p.allow_print === false || p.allow_copy === false || p.allow_edit === false });
  const allowPrint = h("input", { type: "checkbox", checked: p.allow_print !== false });
  const allowCopy = h("input", { type: "checkbox", checked: p.allow_copy !== false });
  const allowEdit = h("input", { type: "checkbox", checked: p.allow_edit !== false });
  const permPw = h("input", { type: "password", autocomplete: "new-password", value: p.permissions_password || "" });
  const err = errorLine();
  const cards = h("div", { class: "scope-cards", role: "radiogroup", "aria-label": "Protection" });
  const detail = h("div", { class: "stack tight" });
  const draw = () => {
    cards.replaceChildren(
      radioCard("protect", "none", "No password", "Anyone can open it", mode === "none", pick),
      radioCard("protect", "password", "Password protect", "Choose who can open, print or copy", mode === "password", pick));
    detail.replaceChildren(mode === "password" ? h("div", { class: "stack tight" },
      h("div", { class: "row wrap" },
        h("label", { class: "field grow" }, h("span", { text: "Password to open (leave empty for none)" }), openPw),
        h("label", { class: "field grow" }, h("span", { text: "Type it again" }), openPw2)),
      h("label", { class: "check" }, restrict, "Restrict what others can do"),
      restrict.checked ? h("div", { class: "subtle-box stack tight" },
        h("label", { class: "check" }, allowPrint, "Allow printing"),
        h("label", { class: "check" }, allowCopy, "Allow copying text and images"),
        h("label", { class: "check" }, allowEdit, "Allow changes, comments and form filling"),
        h("label", { class: "field" }, h("span", { text: "Permissions password (needed to lift the restrictions)" }), permPw),
        h("div", { class: "xs muted", text: "Restrictions are respected by most PDF readers, but not all. For confidential content, use a password to open." })) : null)
      : h("div", { class: "sm muted", text: "The saved PDF will open without a password." }));
  };
  const pick = (value) => { mode = value; err.textContent = ""; draw(); };
  restrict.addEventListener("change", draw);
  draw();
  const result = await modal((close) => [
    h("h2", { text: "Protect this PDF" }),
    h("p", { class: "sm muted", text: "Takes effect when you save. Passwords are not stored anywhere by AW PDF Editor; keep them safe, because a lost password to open cannot be recovered." }),
    cards, detail, err,
    actions(h("button", { class: "btn", type: "button", text: "Cancel", onclick: () => close(null) }),
      h("button", { class: "btn primary", type: "button", text: "Apply", onclick: () => {
        if (mode === "none") return close({ mode: "none" });
        if (openPw.value !== openPw2.value) { err.textContent = "The two passwords to open are not the same."; return; }
        if (!openPw.value && !restrict.checked) { err.textContent = "Set a password to open, or restrict what others can do."; return; }
        if (restrict.checked && !permPw.value) { err.textContent = "Set a permissions password, so the restrictions can't simply be switched off."; return; }
        if (restrict.checked && permPw.value === openPw.value) { err.textContent = "Use a different permissions password from the password to open."; return; }
        close({ mode: "password", open_password: openPw.value,
          permissions_password: restrict.checked ? permPw.value : "",
          allow_print: restrict.checked ? allowPrint.checked : true,
          allow_copy: restrict.checked ? allowCopy.checked : true,
          allow_edit: restrict.checked ? allowEdit.checked : true });
      } })),
  ], { narrow: false, label: "Protect" });
  if (!result) return;
  doc.protect = result;
  setDirty(true);
  render();
  toast(result.mode === "none" ? "The password will be removed when you save." : "Protection will be applied when you save.");
}

// ---------- Settings ----------

function segmented(options, value, onChange) {
  return h("div", { class: "segmented" }, options.map(([id, title]) =>
    h("button", { type: "button", class: value === id ? "on" : "", text: title, onclick: () => onChange(id) })));
}

function renderSettings() {
  const s = state.settings;
  const update = (key) => (value) => { s[key] = value; persist(); applyAppearance(); render(); };
  return h("div", { class: "scroll" }, h("div", { class: "content section" },
    h("div", {}, h("h1", { text: "Settings" }), h("div", { class: "subtitle", text: "These stay on this computer." })),
    h("div", { class: "card stack" },
      h("h2", { text: "Your name" }),
      h("label", { class: "field" }, h("span", { text: "Shown as the author of your comments, and on stamps with “Name and date”" }),
        h("input", { type: "text", value: s.name || "", placeholder: "For example: Neel Kalita", onchange: (e) => { s.name = e.target.value.trim(); persist(); } }))),
    h("div", { class: "card stack" },
      h("h2", { text: "Appearance" }),
      h("div", { class: "field" }, h("span", { text: "Mode" }),
        segmented([["system", "System"], ["light", "Light"], ["dark", "Dark"]], s.appearance, update("appearance"))),
      h("div", { class: "field" }, h("span", { text: "Colour theme" }),
        segmented([["classic", "AccredWorks"], ["blue", "Blue"]], s.colorTheme, update("colorTheme")))),
    h("div", { class: "card stack" },
      h("h2", { text: "Reading" }),
      h("div", { class: "field" }, h("span", { text: "Reopen the files that were open last time" }),
        segmented([["on", "On"], ["off", "Off"]], s.reopenTabs === false ? "off" : "on", (v) => { s.reopenTabs = v === "on"; persist(); reader.saveSession(); render(); })),
      h("div", { class: "field" }, h("span", { text: "Night reading: pages shown light on dark (the file isn't changed)" }),
        segmented([["off", "Off"], ["on", "On"]], s.night ? "on" : "off", (v) => { if (!!s.night !== (v === "on")) reader.command("night"); })),
      h("p", { class: "xs muted", text: "Links in a PDF open only when you click them and confirm. Scripts inside PDFs never run." }))));
}

// ---------- Help & about ----------

function renderHelp() {
  const shortcut = (keys, what) => h("div", { class: "summary-row" }, h("span", { class: "k", text: keys }), h("span", { text: what }));
  const mod = navigator.platform.startsWith("Mac") ? "⌘" : "Ctrl+";
  return h("div", { class: "scroll" }, h("div", { class: "content section" },
    h("div", {}, h("h1", { text: "Help & about" }),
      h("div", { class: "subtitle", text: "AW PDF Editor is free, works offline and never uploads your files." })),
    h("div", { class: "help-grid" },
      h("div", { class: "card help-card" }, h("h2", { text: "Marking up" }),
        h("p", { text: "Choose Mark up. Highlight, underline or strike through text by dragging across it; add notes, text, drawings, shapes, stamps and pictures. Fill in form fields on the page. Watermark, header & footer and Flatten are at the right of the toolbar. Select a mark to move it, drag its corner to resize, Delete to remove; double-click a note or text to change it." })),
      h("div", { class: "card help-card" }, h("h2", { text: "Organising pages" }),
        h("p", { text: "Open a PDF and choose Organise. Click a page to select it, Shift-click for a range, " + (mod === "⌘" ? "⌘" : "Ctrl") + "-click to add one. Drag pages to move them. Nothing is changed on disk until you save." })),
      h("div", { class: "card help-card" }, h("h2", { text: "Shortcuts" }),
        shortcut(`${mod}O`, "Open"), shortcut(`${mod}S`, "Save"), shortcut(`${mod}Z`, "Undo"),
        shortcut(`${mod}A`, "Select all pages (Organise)"), shortcut("Delete", "Delete selected pages")),
      h("div", { class: "card help-card" }, h("h2", { text: "About" }),
        h("p", {}, h("b", { text: "AW PDF Editor™ " }), state.version ? `version ${state.version}` : ""),
        h("p", { text: state.engine ? `PDF engine: ${state.engine}` : "PDF engine: checking…" }),
        h("p", { text: "Made by AccredWorks in Assam, India." })),
      h("div", { class: "card help-card" }, h("h2", { text: "Open source" }),
        h("p", {}, "Free software under the ", h("b", { text: "GNU AGPL, version 3 or later" }),
          ". You may use, study, change and share it. It comes with no warranty."),
        h("p", { text: `Source code: ${SOURCE_REPO} (published with the first release).` }),
        h("p", { text: "The AccredWorks and AW names and logo are not covered by that licence; forks must use their own." })),
      h("div", { class: "card help-card" }, h("h2", { text: "Built with" }),
        h("p", { text: "PyMuPDF and MuPDF (AGPL-3.0), PDF.js (Apache-2.0), Tauri (MIT/Apache-2.0), Python (PSF)." })),
      h("div", { class: "card help-card" }, h("h2", { text: "Signing" }),
        h("p", { text: "To add a digital signature with a USB DSC token, use AW Signer. AW PDF Editor hands the file over; it never handles your token or PIN." }),
        h("p", {}, h("button", { class: "link", type: "button", text: "Get AW Signer", onclick: () => invoke("open_url", { url: SIGNER_DOWNLOAD }) }))))));
}

// ---------- Sign with DSC ----------

/** "Sign with DSC": with a document open and AW Signer installed, save if needed and open the saved PDF
 *  in AW Signer (only the path is passed). Otherwise explain DSC signing and offer AW Signer. */
async function signSheet() {
  const doc = state.section === "Document" ? state.doc : null;
  if (doc) {
    if (doc.dirty || !doc.path) {
      const go = await confirmSheet("Save before signing", "AW Signer signs the file as it is saved on this computer. Save your changes first?", "Save and continue");
      if (!go || !(await save())) return;
    }
    let result = "missing";
    try { result = await invoke("open_in_signer", { path: state.doc.path }); } catch (error) { toast(String(error.message || error), null, true); return; }
    if (result === "handed") {
      toast(`AW Signer is opening with “${state.doc.name}”. Older AW Signer versions don't take the file directly: if it isn't there, choose it in AW Signer.`, state.doc.path);
      return;
    }
    if (result === "started") {
      toast(`AW Signer is opening. This AW Signer can't take the file directly, so “${state.doc.name}” is shown in its folder: choose it in AW Signer.`, state.doc.path);
      return;
    }
  }
  return modal((close) => [
    h("h2", { text: "Sign this PDF with your DSC token" }),
    h("p", { class: "sm muted", text: "A picture of a signature is not a digital signature. To add a real digital signature with your DSC USB token, use AW Signer." }),
    h("div", { class: "subtle-box sm" }, doc
      ? "AW Signer isn't installed on this computer. Once it is, this button opens your saved PDF in it, ready to sign."
      : "Open a PDF first, or get AW Signer and sign any PDF with your token."),
    actions(
      h("button", { class: "btn", type: "button", text: "Close", onclick: () => close() }),
      doc?.path ? h("button", { class: "btn", type: "button", text: "Show in folder", onclick: () => invoke("reveal", { path: doc.path }) }) : null,
      h("button", { class: "btn primary", type: "button", onclick: () => invoke("open_url", { url: SIGNER_DOWNLOAD }) }, icon("external"), "Get AW Signer")),
  ], { label: "Sign with DSC" });
}

// ---------- Toast ----------

let toastTimer;
function toast(text, revealPath = null, bad = false) {
  document.querySelector(".toast")?.remove();
  const element = h("div", { class: `toast${bad ? " bad" : ""}`, role: "status" },
    icon(bad ? "alertCircle" : "checkCircle"), h("span", { text }),
    revealPath ? h("button", { class: "link", type: "button", text: "Show in folder", onclick: () => invoke("reveal", { path: revealPath }) }) : null);
  document.body.append(element);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.remove(), bad ? 9000 : 5000);
}

// ---------- Render ----------

function render() {
  const pages = document.getElementById("pages");
  // Same document, Read or Mark up view on screen: keep the reading position across the redraw.
  if (pages && viewer?.doc === state.doc && state.section === "Document" && ["pages", "markup"].includes(state.doc?.view)) keepScroll = pages.scrollTop;
  renderSidebar();
  viewer?.observer?.disconnect();
  viewer?.thumbObserver?.disconnect();
  viewer?.gridObserver?.disconnect();
  viewer = null;
  const main = document.getElementById("main");
  main.classList.toggle("drop", state.dropActive);
  const view = { Home: renderHome, Document: renderDocument, Settings: renderSettings, Help: renderHelp }[state.section] || renderHome;
  main.replaceChildren(view());
  if (state.section === "Document" && state.doc) {
    requestAnimationFrame(() => {
      if (state.doc.view === "organise") layoutGrid();
      else { layoutPages(); layoutThumbs(); }
    });
  }
  reader.saveSession();
}

document.addEventListener("keydown", (event) => {
  if (document.querySelector(".sheet-backdrop")) return; // a sheet handles its own keys
  const mod = event.metaKey || event.ctrlKey;
  const key = event.key.toLowerCase();
  const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName);
  if (mod && key === "o") { event.preventDefault(); chooseFile(); return; }
  if (mod && key === "w" && state.doc) { event.preventDefault(); closeTab(); return; }
  // Ctrl+Tab / Ctrl+Shift+Tab: next and previous tab
  if (event.ctrlKey && event.key === "Tab" && state.docs.length > 1) {
    event.preventDefault();
    const i = state.docs.indexOf(state.doc);
    activate(state.docs[(i + (event.shiftKey ? -1 : 1) + state.docs.length) % state.docs.length]);
    return;
  }
  // Reading keys (on the Mac the View menu sends these instead; see the "menu" listener).
  const readKey = mod && key === "f" ? "find" : mod && key === "g" ? (event.shiftKey ? "find-previous" : "find-next")
    : event.key === "F3" ? (event.shiftKey ? "find-previous" : "find-next")
    : mod && (key === "=" || key === "+") ? "zoom-in" : mod && key === "-" ? "zoom-out" : mod && key === "0" ? "fit-width" : mod && key === "9" ? "fit-page"
    : (mod && key === "[") || (event.altKey && event.key === "ArrowLeft") ? "back" : (mod && key === "]") || (event.altKey && event.key === "ArrowRight") ? "forward"
    : event.key === "F11" ? "full-screen" : event.key === "F5" ? "present" : null;
  if (readKey && !(typing && !readKey.startsWith("find")) && reader.command(readKey)) { event.preventDefault(); return; }
  if (event.key === "Escape" && reader.isFindOpen()) { reader.closeFind(); return; }
  if (!state.doc || state.section !== "Document") return;
  if (mod && key === "s") { event.preventDefault(); event.shiftKey ? saveAs() : save(); return; }
  if (typing) return;
  if (mod && key === "z") { event.preventDefault(); event.shiftKey ? redo() : undo(); return; }
  if (mod && key === "y") { event.preventDefault(); redo(); return; }
  if (markup.onKey(event)) return;
  if (state.doc.view === "organise") {
    if (mod && key === "a") { event.preventDefault(); selectAll(); }
    else if (key === "delete" || key === "backspace") { event.preventDefault(); deleteSelected(); }
  }
});

let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (state.section === "Document" && ["pages", "markup"].includes(state.doc?.view) && state.doc.fit) layoutPages(); }, 150);
});

listen("drop-hover", ({ payload }) => {
  if (state.dropActive === payload) return;
  state.dropActive = payload;
  document.getElementById("main").classList.toggle("drop", payload);
  document.querySelector(".entry-cards")?.classList.toggle("drop", payload);
});
listen("files-dropped", async ({ payload }) => {
  state.dropActive = false;
  document.getElementById("main").classList.remove("drop");
  const { pdfs, others } = payload;
  if (!pdfs.length && !others.length) {
    toast("Those files can't be opened. Drop PDFs, images, Office or text files.", null, true);
    return;
  }
  if (state.doc && state.section === "Document" && state.doc.view === "organise") {
    insertFromFile(payload); // dropped on the page grid: add the pages
  } else if (pdfs.length === 1 && !others.length) {
    openPdf(pdfs[0]);
  } else {
    openAsNew(payload); // several files, or non-PDFs: combine them into a new PDF, in a new tab
  }
});
// Closing the window: ask about each tab with unsaved changes, in turn; Cancel keeps everything open.
listen("confirm-close", async () => {
  for (const doc of state.docs.filter((d) => d.dirty)) {
    if (!(await closeTab(doc))) return;
  }
  invoke("close_window");
});
// Finder "Open with AW PDF Editor" / a PDF dropped on the Dock icon while the app runs: each in a tab.
listen("open-files", async ({ payload }) => { for (const path of payload) await openPdf(path); });

// The Mac menu bar (main.rs mac_menu). Its shortcuts don't reach the keyboard handler, so they come
// here; on Windows the same keys go through the keyboard handler above.
listen("menu", ({ payload }) => {
  const field = document.activeElement;
  const typing = field && (field.tagName === "TEXTAREA" || (field.tagName === "INPUT" && !["checkbox", "radio"].includes(field.type)));
  if (["undo", "redo", "select-all"].includes(payload) && typing) {
    if (payload === "select-all") field.select();
    else document.execCommand(payload); // the text box's own undo/redo
    return;
  }
  if (document.querySelector(".sheet-backdrop")) return; // a sheet or "Working…" is open
  if (reader.command(payload)) return; // the View menu
  const inDoc = state.doc && state.section === "Document";
  if (payload === "open") chooseFile();
  else if (payload === "save" && inDoc) save();
  else if (payload === "save-as" && inDoc) saveAs();
  else if (payload === "close-tab" && state.doc) closeTab();
  else if (payload === "undo" && inDoc) undo();
  else if (payload === "redo" && inDoc) redo();
  else if (payload === "select-all" && inDoc && state.doc.view === "organise") selectAll();
});

const markup = createMarkup({
  state, h, icon, invoke, worker, modal, actions, toast, edit, setDirty, plural, render, toolButton, undo, redo,
  sourcesForWorker, shownSize, stem, goToPage, plan, saveCopy, withBusy,
});

const reader = createReader({
  state, h, icon, invoke, modal, actions, toast, pdfjs, render, persist, toolButton, goToPage, zoomBy, layoutPages,
  shownSize, drawEntry, baseName, openPdf, slots: () => viewer?.slots,
});

(async () => {
  render();
  state.version = await invoke("app_version");
  await refreshRecent();
  render();
  const launched = await invoke("launch_files");
  for (const path of launched) await openPdf(path); // "Open with", or from a terminal
  if (!launched.length) await reader.restoreSession(); // last time's tabs (Settings > Reading)
  const pong = await invoke("run_worker", { request: { command: "ping" } });
  state.engine = pong.type === "pong" ? pong.engine : `not available (${pong.error})`;
  if (state.section === "Help") render();
})();
