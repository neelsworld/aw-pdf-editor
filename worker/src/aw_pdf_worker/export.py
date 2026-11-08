# SPDX-License-Identifier: AGPL-3.0-or-later
"""Export a PDF to other formats (Acrobat's "Export a PDF"). The PDF is first built from the page
plan (pages.build), so unsaved changes on screen are included. Every file is written next to its
final name and then swapped in, like saving a PDF.

Word uses pdf2docx (MIT). Excel puts each table PyMuPDF finds on a sheet (openpyxl). PowerPoint gives
each page a slide: the page's pictures and drawings as the background, its text as editable text
boxes on top (python-pptx). Images, text, HTML and Markdown come straight from PyMuPDF.
"""

import io
import math
import os
import re
import tempfile
import uuid
from collections import Counter
from pathlib import Path

import pymupdf

from .pages import unique_path

FORMATS = {"docx", "xlsx", "pptx", "png", "jpeg", "tiff", "txt", "html", "md"}


class ExportError(Exception):
    """A problem to show the person, in plain words."""


def _atomic(output, write):
    """Calls write(temp_path), then swaps the result into `output`."""
    folder = os.path.dirname(os.path.abspath(output))
    if not os.path.isdir(folder):
        raise ExportError("The folder to save in does not exist.")
    temp = os.path.join(folder, f".{os.path.basename(output)}.aw-{uuid.uuid4().hex[:8]}.tmp")
    try:
        write(temp)
        os.replace(temp, output)
    except PermissionError:
        raise ExportError("The file could not be saved there. It may be open in another program, or the folder is read-only.")
    finally:
        if os.path.exists(temp):
            os.remove(temp)
    return os.path.getsize(output)


def has_text(doc):
    return any(page.get_text("text").strip() for page in doc)


# ---------- Word ----------

def to_docx(doc, output):
    from pdf2docx import Converter  # imported here: it loads OpenCV, which only Word export needs

    with tempfile.TemporaryDirectory(prefix="aw-docx-") as work:
        source = os.path.join(work, "in.pdf")
        doc.save(source, garbage=3, deflate=True)  # decrypted, with the plan's pages

        def write(temp):
            made = os.path.join(work, "out.docx")
            converter = Converter(source)
            try:
                converter.convert(made, multi_processing=False)
            finally:
                converter.close()
            os.replace(made, temp)

        return _atomic(output, write)


# ---------- Excel ----------

def _cell_value(text):
    """Numbers become numbers (so Excel can calculate), except codes with leading zeros like "007"."""
    if text is None:
        return None
    value = text.strip()
    candidate = value.replace(",", "")
    if re.fullmatch(r"-?(0|[1-9]\d*)(\.\d+)?", candidate):
        number = float(candidate)
        return int(number) if number.is_integer() and "." not in candidate else number
    return value


def to_xlsx(doc, output):
    from openpyxl import Workbook
    from openpyxl.styles import Font

    book = Workbook()
    book.remove(book.active)
    tables_found = 0
    for page in doc:
        try:
            tables = page.find_tables().tables
        except Exception:
            tables = []
        for index, table in enumerate(tables, 1):
            tables_found += 1
            name = f"Page {page.number + 1}" + (f" table {index}" if len(tables) > 1 else "")
            sheet = book.create_sheet(name[:31])
            for r, row in enumerate(table.extract(), 1):
                for c, cell in enumerate(row, 1):
                    sheet.cell(row=r, column=c, value=_cell_value(cell.replace("\n", " ") if cell else cell))
            for cell in sheet[1]:
                cell.font = Font(bold=True)
    warnings = []
    if not tables_found:
        # No tables: one sheet with the text, a line per row, so nothing is lost.
        sheet = book.create_sheet("Text")
        row = 1
        for page in doc:
            for line in page.get_text("text", sort=True).splitlines():
                if line.strip():
                    sheet.cell(row=row, column=1, value=line.strip())
                    row += 1
        warnings.append("No tables were found, so the text was put in one column.")
    size = _atomic(output, lambda temp: book.save(temp))
    return size, warnings


# ---------- PowerPoint ----------

EMU = 12700  # PowerPoint units per point


def _rgb(colour):
    from pptx.dml.color import RGBColor
    return RGBColor((colour >> 16) & 255, (colour >> 8) & 255, colour & 255)


def to_pptx(doc, output, dpi=150):
    from pptx import Presentation
    from pptx.util import Emu, Pt

    deck = Presentation()
    first = doc[0].rect
    deck.slide_width, deck.slide_height = Emu(int(first.width * EMU)), Emu(int(first.height * EMU))
    blank = deck.slide_layouts[6]
    for page in doc:
        slide = deck.slides.add_slide(blank)
        rect = page.rect  # as seen: after rotation and crop
        sx, sy = deck.slide_width / (rect.width * EMU), deck.slide_height / (rect.height * EMU)
        lines = [line for block in page.get_text("dict")["blocks"] if block.get("type") == 0 for line in block["lines"]]
        matrix = page.rotation_matrix
        # Background: the page without its text, so the text boxes on top aren't doubled.
        copy = pymupdf.open()
        copy.insert_pdf(doc, from_page=page.number, to_page=page.number)
        bare = copy[0]
        if lines:
            bare.add_redact_annot(bare.cropbox, fill=False)
            bare.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE, graphics=pymupdf.PDF_REDACT_LINE_ART_NONE,
                                  text=pymupdf.PDF_REDACT_TEXT_REMOVE)
        picture = bare.get_pixmap(dpi=dpi, alpha=False).tobytes("png")
        copy.close()
        slide.shapes.add_picture(io.BytesIO(picture), 0, 0, deck.slide_width, deck.slide_height)
        # Text: one box per line, placed and turned as the line appears on the page.
        for line in lines:
            spans = [s for s in line["spans"] if s["text"].strip()]
            if not spans:
                continue
            x0, y0, x1, y1 = line["bbox"]
            width, height = x1 - x0, y1 - y0
            dx, dy = line["dir"]
            angle = math.degrees(math.atan2(dy, dx))
            if abs(dy) > abs(dx):  # vertical line on the unrotated page: its box runs along the line
                width, height = height, width
            centre = pymupdf.Point((x0 + x1) / 2, (y0 + y1) / 2) * matrix
            box = slide.shapes.add_textbox(
                Emu(int((centre.x - width / 2) * EMU * sx)), Emu(int((centre.y - height / 2) * EMU * sy)),
                # 30% wider than the text: a substituted font (e.g. Calibri for Helvetica) is often
                # wider, and some viewers wrap despite wrap="none". The box itself is invisible.
                Emu(int(width * EMU * sx * 1.3)), Emu(int(height * EMU * sy)))
            box.rotation = (angle + page.rotation) % 360
            frame = box.text_frame
            frame.margin_left = frame.margin_right = frame.margin_top = frame.margin_bottom = 0
            frame.word_wrap = False
            paragraph = frame.paragraphs[0]
            for span in spans:
                run = paragraph.add_run()
                run.text = span["text"]
                run.font.size = Pt(max(1, round(span["size"] * sy, 1)))
                run.font.bold = bool(span["flags"] & 16)
                run.font.italic = bool(span["flags"] & 2)
                run.font.color.rgb = _rgb(span["color"])
    return _atomic(output, lambda temp: deck.save(temp))


# ---------- Images ----------

def to_images(doc, kind, dpi, output=None, folder=None, base_name="Page"):
    """PNG or JPEG: one file per page in `folder` (or `output` when there is one page). TIFF: one
    multi-page file at `output`."""
    if not 36 <= dpi <= 1200:
        raise ExportError("Choose a resolution between 72 and 600 dpi.")
    if kind == "tiff":
        from PIL import Image

        frames = []
        for page in doc:
            pix = page.get_pixmap(dpi=dpi, alpha=False)
            frames.append(Image.frombytes("RGB", (pix.width, pix.height), pix.samples))
        size = _atomic(output, lambda temp: frames[0].save(temp, "TIFF", save_all=True, append_images=frames[1:],
                                                          compression="tiff_lzw", dpi=(dpi, dpi)))
        return [{"path": output, "size_bytes": size}]
    ext = "png" if kind == "png" else "jpg"
    files = []
    for page in doc:
        pix = page.get_pixmap(dpi=dpi, alpha=False)
        data = pix.tobytes("png") if kind == "png" else pix.tobytes("jpeg", jpg_quality=90)
        if output and doc.page_count == 1:
            path = output
        else:
            path = unique_path(folder, f"{base_name} - page {page.number + 1:0{len(str(doc.page_count))}d}.{ext}")
        size = _atomic(path, lambda temp: Path(temp).write_bytes(data))
        files.append({"path": path, "size_bytes": size})
    return files


# ---------- Text, HTML, Markdown ----------

def to_txt(doc, output):
    text = "\n\f".join(page.get_text("text", sort=True).rstrip() for page in doc) + "\n"
    return _atomic(output, lambda temp: Path(temp).write_text(text, encoding="utf-8", newline="\n"))


def to_html(doc, output, title):
    import html as escape

    pages = "\n".join(f'<section class="page" id="page-{p.number + 1}">{p.get_text("xhtml")}</section>' for p in doc)
    page_html = (
        "<!doctype html>\n<html><head><meta charset=\"utf-8\">"
        f"<title>{escape.escape(title)}</title>"
        "<style>body{font-family:sans-serif;max-width:900px;margin:2em auto;padding:0 1em}"
        ".page{border-bottom:1px solid #ccc;padding-bottom:2em;margin-bottom:2em}img{max-width:100%}</style>"
        f"</head><body>\n{pages}\n</body></html>\n")
    return _atomic(output, lambda temp: Path(temp).write_text(page_html, encoding="utf-8"))


def _markdown_page(page):
    """Headings from larger text, paragraphs from text blocks, and tables as Markdown tables."""
    try:
        tables = page.find_tables().tables
    except Exception:
        tables = []
    table_boxes = [pymupdf.Rect(t.bbox) for t in tables]
    blocks = [b for b in page.get_text("dict", sort=True)["blocks"] if b.get("type") == 0]
    sizes = Counter(round(s["size"]) for b in blocks for l in b["lines"] for s in l["spans"] if s["text"].strip())
    body = sizes.most_common(1)[0][0] if sizes else 11
    items = []  # (top, markdown)
    for table, box in zip(tables, table_boxes):
        items.append((box.y0, table.to_markdown().strip()))
    for block in blocks:
        box = pymupdf.Rect(block["bbox"])
        if any(box.intersects(t) for t in table_boxes):
            continue
        spans = [s for l in block["lines"] for s in l["spans"] if s["text"].strip()]
        if not spans:
            continue
        text = " ".join(" ".join(s["text"].strip() for s in l["spans"] if s["text"].strip()) for l in block["lines"]).strip()
        size = max(s["size"] for s in spans)
        bold = all(s["flags"] & 16 for s in spans)
        if re.fullmatch(r"[\d\s./-]+", text):  # page numbers and dates printed large are not headings
            pass
        elif size >= body * 1.6:
            text = f"# {text}"
        elif size >= body * 1.25:
            text = f"## {text}"
        elif bold and len(text) < 90:
            text = f"### {text}"
        items.append((box.y0, text))
    return "\n\n".join(md for _top, md in sorted(items, key=lambda item: item[0]))


def to_md(doc, output):
    text = "\n\n---\n\n".join(_markdown_page(page) for page in doc).strip() + "\n"
    return _atomic(output, lambda temp: Path(temp).write_text(text, encoding="utf-8", newline="\n"))
