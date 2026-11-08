# Phase 1 report: Organise (2026-11-02)

## What it does

- **Two views of a document:** *Read* (continuous pages and thumbnails) and *Organise* (a page grid).
  Switch with the Read / Organise control in the toolbar.
- **Organise:** click to select; Shift-click for a range; ⌘/Ctrl-click to add one; ⌘/Ctrl-A selects all.
  Drag to reorder (one or many pages). Double-click a page to read it.
- **Page actions** (action bar, both views; in Read they act on the current page):
  - rotate left/right, delete, duplicate;
  - crop margins in mm, as the page looks on screen, so it also works on rotated pages;
  - insert a blank page (same size as its neighbour), insert pages from other PDFs;
  - replace pages with pages from another PDF;
  - extract to a new PDF (optionally deleting them from this one).
- **Undo / redo** for every page change (⌘/Ctrl-Z, ⇧⌘Z or Ctrl-Y), up to 100 steps.
- **Merge** (Home → Merge PDFs, or drop PDFs on the Organise grid): any number of files become one
  new document. On saving, each file gets a top-level bookmark with its own bookmarks nested underneath,
  like Acrobat's Combine.
- **Split** (action bar, or Home → Split a PDF): every N pages, page ranges ("1-3, 4-10"), top-level
  bookmarks (parts named after them) or a maximum file size. Parts go to a folder you choose; existing
  files are never replaced (" (2)" is added). The document itself is not changed.
- **Protect:** a password to open, and/or restrictions on printing, copying and editing with a
  permissions password (AES-256). Password-protected PDFs open after asking for the password, which is
  kept only in memory. Saving keeps the password unless it's changed or removed.
- **Save** writes over the open file. **Save as** writes a new file. A merged document's first Save is
  a Save as. Writing is atomic: temp file, then swap, so a crash never leaves half a PDF. After saving,
  the window reopens the file from disk, so what you see is what was written.
- **Safety nets:** "Save changes first?" before opening another file or closing the window with unsaved
  changes. A warning before saving changes to a digitally signed PDF (that invalidates its signature).
- **Bookmarks** follow their pages when pages move; bookmarks of deleted pages go.

## How it's built

- The UI keeps a *page plan*; nothing touches the disk until Save (`app/ui/app.js`).
- The worker builds the PDF from the plan with PyMuPDF (`worker/src/aw_pdf_worker/pages.py`): pages
  are copied with a shared copy map, so fonts and images used by many pages are stored once.
- The Rust shell checks every worker request: the engine may read only files you opened, and write only
  over an opened file, to a path from the save dialog, or into a folder you picked (`check_request` in
  `main.rs`).

## Tests

- Worker: 25 tests (`worker/tests/`). They cover reorder, delete, duplicate, rotation, crop on a rotated
  page, blank pages, merge bookmarks, bookmark remapping, password round trip, restrictions, atomic save
  over the open file, no silent overwrite, bad plans, shared-resource size, and the four split modes plus
  unique names.
- Rust: 4 tests, including that worker requests can't reach files you didn't choose.
- End to end in the browser pane, with the real worker behind a test stand-in for the shell:
  - Organise: rotate, drag to reorder, Shift-select, delete, insert from file, undo/redo, crop 20 mm,
    protect, then Save as. Checked with PyMuPDF: page order, rotation, 210 × 277 mm crop, password
    required, bookmarks remapped.
  - Split by bookmarks: 3 named parts.
  - Merge of 2 files: 9 pages, per-file bookmarks.
  - Unsaved-changes guard.
  - Light and dark mode.

## Not yet checked

- In the real Mac window: the native dialogs (open several, save, choose folder), real mouse dragging,
  closing the window with unsaved changes. The dev app is rebuilt with Phase 1 for trying these by hand.
- Windows: not run yet. Note: page dragging uses pointer events because HTML drag-and-drop clashes with
  file dropping in Windows WebView2.
- Very large files (500+ pages): splitting by size checks sizes page by page and will be slow there.
