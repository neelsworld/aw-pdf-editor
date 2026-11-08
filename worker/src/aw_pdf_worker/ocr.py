# SPDX-License-Identifier: AGPL-3.0-or-later
"""OCR (Phase 4): makes scanned pages searchable and copyable, offline.

MuPDF has Tesseract built in, so only the language data is bundled (worker/tessdata, tessdata_fast,
Apache-2.0). For each page that needs it:
  1. render the page as it is seen (rotation and crop applied) at 300 dpi;
  2. let MuPDF's OCR make a one-page PDF from that picture (picture + invisible text);
  3. drop the picture from that page, keeping only the invisible text;
  4. lay the invisible text over the original page.
The original scan is not re-encoded or changed in any way; it just gains a text layer, so its look and
file size stay the same. Checked on every rotation and crop (tests/test_phase4.py).
"""

import os
import sys

import pymupdf

from .marks import on_page

LANGUAGES = {"eng": "English", "asm": "Assamese", "ben": "Bengali", "hin": "Hindi"}
DPI = 300


class OcrError(Exception):
    """A problem to show the person, in plain words."""


def tessdata_dir():
    """The bundled language data: next to the packed worker, or worker/tessdata in development."""
    candidates = [os.environ.get("AW_TESSDATA")]
    if getattr(sys, "_MEIPASS", None):  # PyInstaller
        candidates.append(os.path.join(sys._MEIPASS, "tessdata"))
    candidates.append(os.path.join(os.path.dirname(__file__), "..", "..", "tessdata"))
    for folder in candidates:
        if folder and os.path.isfile(os.path.join(folder, "eng.traineddata")):
            return os.path.abspath(folder)
    raise OcrError("The OCR language data is missing from this installation. Reinstall AW PDF Editor.")


def needs_ocr(page):
    """A page without real text that shows at least one picture: a scan or a photo of a document."""
    if page.get_text("text").strip():
        return False
    return bool(page.get_images(full=False))


def add_text_layer(page, languages):
    """Adds an invisible OCR text layer to one page. Returns the number of words found."""
    folder = tessdata_dir()
    codes = [code for code in languages if code in LANGUAGES] or ["eng"]
    missing = [code for code in codes if not os.path.isfile(os.path.join(folder, f"{code}.traineddata"))]
    if missing:
        raise OcrError(f"OCR data for {', '.join(LANGUAGES[c] for c in missing)} is missing.")
    picture = page.get_pixmap(dpi=DPI)  # as seen, so the text lines up with what is on screen
    scanned = pymupdf.open("pdf", picture.pdfocr_tobytes(language="+".join(codes), tessdata=folder))
    layer = scanned[0]
    words = len(layer.get_text("words"))
    if not words:
        scanned.close()
        return 0
    layer.add_redact_annot(layer.rect, fill=False)  # keep the text, drop the picture copy
    layer.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_REMOVE, graphics=pymupdf.PDF_REDACT_LINE_ART_NONE,
                           text=pymupdf.PDF_REDACT_TEXT_NONE)
    on_page(page, page.rect, lambda flat, target, rotation:
            flat.show_pdf_page(target, scanned, 0, rotate=rotation, overlay=True))
    scanned.close()
    return words


def ocr_page(page, settings):
    """settings: {"languages": ["eng", "asm"], "all_pages": false}. Returns words added (0 if skipped)."""
    if not settings:
        return 0
    if not settings.get("all_pages") and not needs_ocr(page):
        return 0
    return add_text_layer(page, settings.get("languages") or ["eng"])
