# Phase 3 report: Mark up and fill (2026-11-02)

## What it does

A third view, **Mark up**, next to Read and Organise.

**Tools** (Mark up toolbar):

| Tool | How it's saved |
|---|---|
| Highlight, underline, strike through | Drag across text; the mark snaps to the words. Saved as real text-markup annotations on those words (a highlight over a picture becomes a translucent box) |
| Sticky note | Click, type. A note annotation with your name as author |
| Draw (pen), rectangle, ellipse, line, arrow | Annotations, in five colours and three line widths |
| Stamp | Reviewed, Verified, Approved, Rejected, Received, Checked, Copy, Draft, Confidential, Original, optionally with your name and today's date. A stamp annotation (movable in Acrobat) with its look drawn by AW PDF Editor, so the name line can be in any script |
| Add text | Drag a box or click, type. Becomes part of the page, so Assamese, Bengali and Hindi come out right |
| Picture or logo, signature picture | Choose a PNG/JPEG; click to place. Becomes part of the page. A signature picture always comes with the reminder that it is a picture, not a digital signature (use Sign with DSC) |

- **Select and move:** click a mark to select it, drag to move, drag the corner to resize boxes and pictures (pictures keep their shape), Delete to remove, double-click a note or text to change it, Esc to stop. Every change can be undone with the page history.
- **Forms:** fields appear as light-blue boxes on the page, in both Read and Mark up (text, tick boxes, radio buttons, lists). Values are saved into the fields by name.
- **Watermark:** text across every page at 45°, with colour and strength. Previewed on screen, added on save.
- **Header, footer and page numbers:** six positions, `{n}`, `{N}`, `{date}`, `{file}`, size, margin, first number, optional cover page left out. One-click presets. Previewed on screen.
- **Flatten:** turns comments, stamps and form fields into part of the page on save.
- **Comments list:** a panel listing everything you added, by page; click one to go to it.
- **Your name** (Settings): author of your comments and the name on stamps.

Marks belong to their page: they move, duplicate and are deleted with it in Organise, and they are
included in Save, Save as, Extract, Split and Export.

## How it's built

- Marks are kept in *visual* points (as the page is seen, after rotation and crop) on each page-plan
  entry (`app/ui/markup.js`). The worker writes them in `worker/src/aw_pdf_worker/marks.py`.
- Coordinates were checked for every rotation, with and without crop, and with two paper sizes:
  - annotations use `rect × derotation_matrix`;
  - page content is drawn while the page is briefly unrotated and uncropped. PyMuPDF misplaces content
    on pages that are both rotated and cropped otherwise; `on_page()` makes the order of steps safe.
- A new worker command, `page_layer`, gives the words, form fields and existing comments of a page as
  seen. It's used for snapping highlights and placing fields.
- Drawn pages are cached, so adding or moving a mark doesn't redraw every page, and the reading position
  is kept.
- Rust: `pick_image` reads a chosen picture and hands it to the page (no file access from the page);
  `page_layer` requests are checked like the others. New dependency: the `base64` crate (MIT/Apache-2.0),
  the same one AW Signer uses.

## Tests

- Worker: 54 in all (12 new). They cover: annotations landing where drawn on every rotation and crop;
  all annotation kinds with author and comment; a highlight over a picture; added text and picture as
  page content on a rotated page; marks on a blank page; form values by name; flatten; watermark and
  page numbers on every page, footer at the bottom of a turned page; numbering with a cover left out;
  the page layer as seen; an unknown mark refused; marks and additions included in export.
- Rust: 6, including the page-layer check.
- End to end in the browser pane with the real worker, on a form PDF:
  - filled 3 fields, highlighted a sentence, added a note, Assamese text, a rectangle, a stamp and a
    signature picture, moved the stamp (exactly 40 × 20 pt), undo/redo, watermark and page numbers;
  - saved, then checked with PyMuPDF (annotations, field values, text, footer on both pages) and by
    rendering the saved page, which matches the screen;
  - comments list checked too.
- Found and fixed along the way:
  - dragging an unselected mark threw it off the page;
  - content placed inside the "flattened" step used the wrong rotation;
  - watermark direction on rotated pages;
  - rich-text stamps losing their second line, replaced by drawn stamps;
  - a test crash from PyMuPDF page lifetime.

## Not yet checked / limitations

- In the real Mac window and on Windows: real mouse and trackpad drawing, the picture dialog. The dev app
  is rebuilt with Phase 3.
- Existing comments in a PDF are shown and kept, but can't be edited or deleted yet.
- Watermark and header/footer changes aren't part of undo (open the sheet again to change or remove).
- Highlight snapping needs selectable text; on scans it marks the dragged area (OCR comes in Phase 4).

## Added after Phase 3: tabs (2026-11-05, Neel's request)

Neel noticed there was no way to close an open PDF and asked for tabs. Now:

- **Every open PDF has a tab** above the toolbar, with its name, an unsaved-changes dot and a × close
  button. The + button opens another PDF. Opening, Create PDF, Merge, recent files and dropped files all
  open in a new tab. Opening a file that is already open switches to its tab.
- **Closing:**
  - × (or middle-click) on a tab, ⌘W on Mac, or Ctrl+W on Windows;
  - a tab with unsaved changes asks Save / Discard / Cancel;
  - closing the last tab goes back to Home;
  - closing the window asks about each changed tab in turn.
- **Ctrl+Tab / Ctrl+Shift+Tab** switch tabs. The sidebar shows "Documents (n)" when several are open.
- **Saving** keeps the document in the same tab (now showing the saved file).
- **Each tab keeps its own** pages, marks, form values, undo history, cached page pictures and page
  layers. The cache keys include the tab, so two documents never mix.
- **Mac menu:** the standard menu's ⌘W would have closed the whole window, so the app now has its own
  menu bar:
  - File: Open, Save, Save As, Close Tab ⌘W, Close Window ⇧⌘W;
  - Edit: Undo, Redo, Cut, Copy, Paste, Select All;
  - Undo, Redo and Select All act on a focused text box, otherwise on the document.
  - Windows has no menu bar; the same keys work through the page.
- **Toolbar:** the file name moved from the toolbar to the tab.

Checked in the browser pane:
- opening three files, and re-opening one (switched, no duplicate);
- switching tabs while keeping unsaved rotation;
- closing a clean tab (no question), and a changed tab (Cancel kept it, Discard closed it);
- the menu's Close Tab on the last tab, back to Home;
- closing the window with two changed tabs (asked twice, then closed);
- Save as updating the tab in place;
- a note added in one tab not appearing in another.

The real Mac menu has not been clicked by hand yet.
