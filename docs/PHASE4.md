# Phase 4 report: Redact, edit text, OCR, compress, batch (2026-11-05)

## What it does

| Feature | Where | How it works |
|---|---|---|
| **Make searchable (OCR)** | Mark up toolbar, Home card, Batch | Reads the text in scanned pages, fully offline, in English, Assamese, Bengali and Hindi (any mix). Saves a searchable copy. The scan itself is **not changed** (same look, about the same size); it gains an invisible text layer that can be searched, copied, highlighted and exported. Pages that already have text are skipped unless asked. About a second per page |
| **Redact** | Mark up: "Mark an area for redaction" tool, Find & redact…, Home card | Marked areas show dark and hatched until saved. On save, after a clear "for good" confirmation: text, image pixels, fully-covered drawings, and any comment or form field touching the area are removed and painted black. Then the app **checks** that no text is left under any box and refuses to save if there is. Optionally (on by default) it also removes hidden information: metadata, attachments, scripts, thumbnails |
| **Find & redact** | Mark up toolbar | Words or names you type, plus e-mail addresses, Indian mobile numbers, Aadhaar numbers and PAN numbers, are found on every page and marked for redaction to review before saving. Works on scans after OCR |
| **Edit text (beta)** | Mark up: "Edit text" tool | Lines get an outline; click one, change it. The old text is removed (only the text: backgrounds and lines stay) and the new text is written in the same place, size, colour, weight and style (sans/serif/mono). Labelled "beta, best for short corrections" |
| **Reduce file size** | Read/Organise action bar | Saves a smaller copy at one of three levels. *Tidy only* leaves pictures alone. *Balanced* takes pictures above 225 dpi down to 150 dpi (JPEG 75). *Smallest* goes to 100 dpi (JPEG 60) and trims fonts. Shows before → after |
| **Batch** | Home card | One action on many PDFs: reduce size, make searchable, page numbers, watermark, export to Word or text. Results go into a chosen folder, the originals are untouched, nothing is replaced (names get " (2)"), and there's a per-file result list. Password-protected files are skipped with a note |

## How it's built

- **OCR without bundling Tesseract.** MuPDF (inside PyMuPDF) has Tesseract built in. Only the language
  data is shipped: `worker/tessdata/` from tessdata_fast (Apache-2.0), eng, asm, ben and hin, 7.8 MB,
  with checksums in its README. The OCR page's picture is removed and only its invisible text is laid
  over the original page (`worker/src/aw_pdf_worker/ocr.py`).
  - So **OCRmyPDF and Ghostscript are not needed for OCR.**
  - Checked on every rotation (the real-world case: an image stored sideways, made upright by the page
    rotation) and with crops.
- **Order on each page:** crop → OCR → text edits → other marks → redactions. A redaction therefore also
  removes OCR text, edited text and added content under it. MuPDF's redaction also reaches text inside
  form objects (tested), which matters for PDFs made by Word and for the OCR layer.
- New worker command `find_text`. `page_layer` now also returns text lines with their look, for Edit
  text. `apply_plan` takes `compress` and `unique`.
- **Rust:** batch output is allowed only inside a folder the person chose; `find_text` is checked like
  the other requests.

## Tests

- Worker: 65 in all (11 new). They cover:
  - OCR searchable with the look unchanged and small size growth, rotated scans, pages with text
    skipped, Assamese;
  - redaction: text, pixels, comments and fields removed, the secret absent from the file bytes, the
    line below kept, works on a turned page;
  - redaction after OCR;
  - Find & redact patterns on a turned page;
  - Edit text keeps neighbouring lines;
  - all three compression levels; scrub keeps OCR text; batch never replaces.
- Rust: 6, including the batch-folder and find checks.
- End to end in the browser pane, with the real worker:
  - a picture-only private record was OCR'd, then Find & redact found the name, phone, e-mail and
    Aadhaar number. After saving with the confirmation, checked independently: those are gone from
    the text and from the file, pixels are black, metadata is removed, the other lines stay;
  - Edit text on a heading keeps its yellow bar and bold style;
  - Reduce size works;
  - Batch added page numbers to 2 files.
- The packed worker (PyInstaller) does OCR with its bundled language data, with any system Tesseract
  data hidden.

## Size

The packed worker is 226 MB on disk, **about 96 MB compressed; about 98 MB download with the shell**
(Mac, Apple Silicon). That's within the 150–200 MB budget.

## Known limitations

- OCR in Assamese, Bengali and Hindi sometimes runs words together (spaces lost). This comes from the
  fast models. The larger tessdata_best models read better but are about 4× bigger and slower, which
  could be an option later.
- OCR is applied when saving a copy, so Find & redact on a scan needs the searchable copy first. The
  Find sheet says so.
- Edit text replaces whole single lines and matches the font family, not the exact font. Multi-line
  paragraph editing is v1.x.
- Very large scans draw slowly in the viewer at high zoom (seen during testing; the file is fine).
- Not yet checked by hand in the real Mac window, nor on Windows.
