# SPDX-License-Identifier: AGPL-3.0-or-later
"""Create PDF from other files (Acrobat's "Create a PDF").

Images and text/HTML/Markdown are converted here with PyMuPDF and Pillow. Word, Excel, PowerPoint,
OpenDocument and RTF files need an office suite: Microsoft Office on Windows when it is installed,
otherwise LibreOffice. Neither is bundled (LibreOffice alone is ~800 MB); the app explains how to
install LibreOffice when no suite is found. Every conversion runs offline on this computer.
"""

import html
import io
import os
import shutil
import subprocess
import sys
import uuid
from pathlib import Path

import pymupdf
from PIL import Image, ImageOps

IMAGE_TYPES = {".jpg", ".jpeg", ".png", ".tif", ".tiff", ".bmp", ".gif", ".webp"}
TEXT_TYPES = {".txt", ".text", ".csv"}
HTML_TYPES = {".html", ".htm"}
MARKDOWN_TYPES = {".md", ".markdown"}
OFFICE_TYPES = {".doc", ".docx", ".odt", ".rtf", ".xls", ".xlsx", ".ods", ".ppt", ".pptx", ".odp"}
WORD = {".doc", ".docx", ".odt", ".rtf"}
EXCEL = {".xls", ".xlsx", ".ods"}
POWERPOINT = {".ppt", ".pptx", ".odp"}

PAPER = {"a4": pymupdf.paper_rect("a4"), "letter": pymupdf.paper_rect("letter")}
MARGIN = 28.35  # 10 mm around images on a fixed paper size
TEXT_MARGIN = 56.7  # 20 mm around text pages
OFFICE_TIMEOUT = 180  # seconds per file; the first LibreOffice run also sets up its profile

# Text pages: the system's sans-serif look. MuPDF falls back to its built-in Noto fonts for
# Bengali/Assamese, Devanagari and other scripts, and shapes them correctly.
TEXT_CSS = """
body { font-family: sans-serif; font-size: 11pt; line-height: 1.4; }
h1 { font-size: 20pt; } h2 { font-size: 16pt; } h3 { font-size: 13pt; }
pre, code { font-family: monospace; font-size: 9.5pt; }
table { border-collapse: collapse; } td, th { border: 0.5pt solid #888; padding: 2pt 5pt; }
"""


class ConvertError(Exception):
    """A problem with one file, in plain words."""


# ---------- Finding an office suite ----------

def find_libreoffice():
    override = os.environ.get("AW_SOFFICE")
    candidates = [override] if override else []
    if sys.platform == "darwin":
        candidates += ["/Applications/LibreOffice.app/Contents/MacOS/soffice",
                       os.path.expanduser("~/Applications/LibreOffice.app/Contents/MacOS/soffice")]
    elif os.name == "nt":
        for base in (os.environ.get("ProgramFiles"), os.environ.get("ProgramFiles(x86)")):
            if base:
                candidates.append(os.path.join(base, "LibreOffice", "program", "soffice.exe"))
    candidates += [shutil.which("soffice"), shutil.which("libreoffice")]
    return next((c for c in candidates if c and os.path.isfile(c)), None)


def find_microsoft_office():
    """Windows only: which Office apps can be driven (their COM servers are registered)."""
    if os.name != "nt":
        return []
    import winreg  # standard library on Windows
    found = []
    for name in ("Word.Application", "Excel.Application", "PowerPoint.Application"):
        try:
            winreg.CloseKey(winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, name + "\\CLSID"))
            found.append(name.split(".")[0])
        except OSError:
            pass
    return found


def office_status():
    return {"libreoffice": find_libreoffice(), "microsoft_office": find_microsoft_office()}


# PowerShell scripts that ask Microsoft Office itself to save a PDF ("Export as PDF"). Paths go in
# through environment variables, so no quoting problems with spaces or Indian-script file names.
# NOTE: written for Windows; not yet run on a Windows PC (PHASE2.md).
_PS = {
    "Word": "$a=New-Object -ComObject Word.Application;$a.Visible=$false;$a.DisplayAlerts=0;"
            "try{$d=$a.Documents.Open($env:AW_IN,$false,$true);$d.ExportAsFixedFormat($env:AW_OUT,17);$d.Close(0)}finally{$a.Quit()}",
    "Excel": "$a=New-Object -ComObject Excel.Application;$a.Visible=$false;$a.DisplayAlerts=$false;"
             "try{$b=$a.Workbooks.Open($env:AW_IN,0,$true);$b.ExportAsFixedFormat(0,$env:AW_OUT);$b.Close($false)}finally{$a.Quit()}",
    "PowerPoint": "$a=New-Object -ComObject PowerPoint.Application;"
                  "try{$p=$a.Presentations.Open($env:AW_IN,-1,0,0);$p.SaveAs($env:AW_OUT,32);$p.Close()}finally{$a.Quit()}",
}


def _with_microsoft_office(path, output, app):
    env = dict(os.environ, AW_IN=os.path.abspath(path), AW_OUT=os.path.abspath(output))
    run = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", _PS[app]],
                         env=env, capture_output=True, timeout=OFFICE_TIMEOUT, creationflags=0x08000000)
    if run.returncode != 0 or not os.path.isfile(output):
        raise ConvertError(f"Microsoft {app} could not convert this file.")


def _with_libreoffice(soffice, path, output, profile_dir):
    # A separate LibreOffice profile, so a LibreOffice window the person has open doesn't block us.
    work = os.path.join(os.path.dirname(output), f".lo-{uuid.uuid4().hex[:8]}")
    os.makedirs(work)
    try:
        run = subprocess.run(
            [soffice, f"-env:UserInstallation={Path(profile_dir).absolute().as_uri()}", "--headless", "--norestore",
             "--nolockcheck", "--convert-to", "pdf", "--outdir", work, path],
            capture_output=True, timeout=OFFICE_TIMEOUT,
            creationflags=0x08000000 if os.name == "nt" else 0)
        made = os.path.join(work, Path(path).stem + ".pdf")
        if run.returncode != 0 or not os.path.isfile(made):
            raise ConvertError("LibreOffice could not convert this file. It may be damaged or password-protected.")
        os.replace(made, output)
    except subprocess.TimeoutExpired:
        raise ConvertError("LibreOffice took too long with this file.")
    finally:
        shutil.rmtree(work, ignore_errors=True)


def office_to_pdf(path, output, profile_dir):
    ext = Path(path).suffix.lower()
    app = "Word" if ext in WORD else "Excel" if ext in EXCEL else "PowerPoint"
    if app in find_microsoft_office() and ext not in {".odt", ".ods", ".odp"}:
        try:
            return _with_microsoft_office(path, output, app)
        except (ConvertError, subprocess.TimeoutExpired, OSError):
            pass  # fall back to LibreOffice when it is there
    soffice = find_libreoffice()
    if not soffice:
        raise ConvertError("NO_OFFICE")
    _with_libreoffice(soffice, path, output, profile_dir)


# ---------- Images ----------

def _image_frames(path):
    """The image's pages (several for a multi-page TIFF), turned upright per their EXIF orientation,
    as (bytes, width_px, height_px, dpi). JPEGs that need no turning are passed through unchanged."""
    try:
        image = Image.open(path)
    except Exception:
        raise ConvertError("This image could not be read.")
    frames = []
    with image:
        count = getattr(image, "n_frames", 1) if image.format in {"TIFF"} else 1
        for index in range(count):
            image.seek(index)
            dpi = image.info.get("dpi", (96, 96))[0] or 96
            if image.format == "JPEG" and image.getexif().get(0x0112, 1) == 1:
                frames.append((Path(path).read_bytes(), image.width, image.height, dpi))
                continue
            upright = ImageOps.exif_transpose(image.copy())
            if upright.mode not in {"RGB", "L", "RGBA", "LA"}:
                upright = upright.convert("RGBA" if "A" in upright.mode or "transparency" in upright.info else "RGB")
            buffer = io.BytesIO()
            if image.format == "JPEG":
                upright.save(buffer, "JPEG", quality=92)
            else:
                upright.save(buffer, "PNG", optimize=True)
            frames.append((buffer.getvalue(), upright.width, upright.height, dpi))
    return frames


def images_to_pdf(path, output, page_size="image"):
    doc = pymupdf.open()
    for data, w_px, h_px, dpi in _image_frames(path):
        w_pt, h_pt = w_px * 72 / float(dpi), h_px * 72 / float(dpi)
        if page_size in PAPER:
            paper = PAPER[page_size]
            if w_pt > h_pt:  # landscape picture: landscape paper
                paper = pymupdf.Rect(0, 0, paper.height, paper.width)
            page = doc.new_page(width=paper.width, height=paper.height)
            area = page.rect + (MARGIN, MARGIN, -MARGIN, -MARGIN)
            scale = min(area.width / w_pt, area.height / h_pt, 1.0)  # never enlarge
            w, h = w_pt * scale, h_pt * scale
            x0, y0 = area.x0 + (area.width - w) / 2, area.y0 + (area.height - h) / 2
            page.insert_image(pymupdf.Rect(x0, y0, x0 + w, y0 + h), stream=data)
        else:
            page = doc.new_page(width=w_pt, height=h_pt)
            page.insert_image(page.rect, stream=data)
    doc.save(output, garbage=3, deflate=True)
    doc.close()


# ---------- Text, HTML, Markdown ----------

def _read_text(path):
    raw = Path(path).read_bytes()
    for encoding in ("utf-8-sig", "utf-16", "cp1252"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def html_to_pdf(body_html, output, base_folder=None):
    story = pymupdf.Story(html=body_html, user_css=TEXT_CSS,
                          archive=pymupdf.Archive(base_folder) if base_folder else None)
    writer = pymupdf.DocumentWriter(output)
    paper = PAPER["a4"]
    area = paper + (TEXT_MARGIN, TEXT_MARGIN, -TEXT_MARGIN, -TEXT_MARGIN)
    more = True
    while more:
        device = writer.begin_page(paper)
        more, _ = story.place(area)
        story.draw(device)
        writer.end_page()
    writer.close()


def text_to_pdf(path, output):
    ext = Path(path).suffix.lower()
    text = _read_text(path)
    if ext in HTML_TYPES:
        return html_to_pdf(text, output, base_folder=os.path.dirname(path))
    if ext in MARKDOWN_TYPES:
        import markdown
        body = markdown.markdown(text, extensions=["tables", "fenced_code", "sane_lists"])
        return html_to_pdf(body, output, base_folder=os.path.dirname(path))
    if ext == ".csv":
        import csv
        rows = list(csv.reader(io.StringIO(text)))
        cells = "".join("<tr>" + "".join(f"<td>{html.escape(c)}</td>" for c in row) + "</tr>" for row in rows)
        return html_to_pdf(f"<table>{cells}</table>", output)
    paragraphs = "".join(f"<p>{html.escape(line) or '&nbsp;'}</p>" for line in text.splitlines())
    html_to_pdf(f"<div style='font-family: monospace; font-size: 10pt'>{paragraphs}</div>", output)


# ---------- One entry point ----------

def kind_of(path):
    ext = Path(path).suffix.lower()
    if ext == ".pdf":
        return "pdf"
    if ext in IMAGE_TYPES:
        return "image"
    if ext in TEXT_TYPES | HTML_TYPES | MARKDOWN_TYPES:
        return "text"
    if ext in OFFICE_TYPES:
        return "office"
    return None


def to_pdf(path, out_dir, page_size="image", profile_dir=None):
    """Converts one file into a new PDF in `out_dir` and returns its path."""
    if not os.path.isfile(path):
        raise ConvertError("The file could not be found.")
    kind = kind_of(path)
    if kind in (None, "pdf"):
        raise ConvertError("This kind of file can't be turned into a PDF here.")
    output = os.path.join(out_dir, f"{uuid.uuid4().hex[:8]}-{Path(path).stem}.pdf")
    try:
        if kind == "image":
            images_to_pdf(path, output, page_size)
        elif kind == "text":
            text_to_pdf(path, output)
        else:
            office_to_pdf(path, output, profile_dir or os.path.join(out_dir, "office-profile"))
    except ConvertError:
        raise
    except Exception as error:
        if os.path.exists(output):
            os.remove(output)
        print(f"convert {kind}: {type(error).__name__}: {error}", file=sys.stderr)
        raise ConvertError("This file could not be converted.")
    return output
