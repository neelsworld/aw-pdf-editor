# SPDX-License-Identifier: AGPL-3.0-or-later
"""The worker's commands.

ping           is the engine there?
info           open a PDF (with its password if it has one) and describe it
apply_plan     save the arranged pages (Organise, Merge, Extract, Protect) to one PDF
split          save the arranged pages as several PDFs in a folder
office_status  is there an office suite for Word/Excel/PowerPoint files?
to_pdf         convert images, text and office files to PDFs (Create PDF)
export         save the arranged pages as Word, Excel, PowerPoint, images, text, HTML or Markdown
page_layer     words, form fields and existing comments of one arranged page, for the on-screen tools
find_text      where words or patterns (e-mail, phone, Aadhaar, PAN) are, for Find & redact
"""

import os

import pymupdf

from . import __version__
from . import convert as converter
from . import export as exporter
from .marks import page_layer as read_page_layer
from .pages import PlanError, build, safe_name, save_atomic, split_ranges, unique_path


class WorkerError(Exception):
    """A problem to show the person as-is (plain words, no stack trace)."""


def ping(_request):
    return {
        "type": "pong",
        "worker": __version__,
        "engine": f"PyMuPDF {pymupdf.VersionBind} / MuPDF {pymupdf.VersionFitz}",
    }


def _open(path):
    if not isinstance(path, str) or not path:
        raise WorkerError("No file was given.")
    if not os.path.isfile(path):
        raise WorkerError("That file could not be found. It may have been moved or renamed.")
    try:
        return pymupdf.open(path)
    except Exception:
        raise WorkerError("This file could not be opened as a PDF. It may be damaged or not a PDF.")


def info(request):
    path = request.get("path")
    with _open(path) as doc:
        if not doc.is_pdf:
            raise WorkerError("This file is not a PDF.")
        encrypted = bool(doc.needs_pass)
        if encrypted:
            password = request.get("password")
            if password is None:
                return {"type": "info", "path": path, "needs_password": True, "encrypted": True,
                        "size_bytes": os.path.getsize(path)}
            if not doc.authenticate(password):
                raise WorkerError("That password is not correct.")
        meta = doc.metadata or {}
        first = doc[0].rect if doc.page_count else None
        return {
            "type": "info",
            "path": path,
            "size_bytes": os.path.getsize(path),
            "pages": doc.page_count,
            "needs_password": False,
            "encrypted": encrypted,
            "title": meta.get("title") or "",
            "author": meta.get("author") or "",
            "producer": meta.get("producer") or "",
            "pdf_version": meta.get("format") or "",
            # Points (1/72 inch); the app shows them as mm.
            "first_page_size": [round(first.width, 1), round(first.height, 1)] if first else None,
            "has_forms": bool(doc.is_form_pdf),
            "signed": bool(doc.get_sigflags() > 0),
            "top_bookmarks": sum(1 for level, _t, _p in doc.get_toc(simple=True) if level == 1),
        }


def apply_plan(request):
    output = request.get("output")
    if not isinstance(output, str) or not output.lower().endswith(".pdf"):
        raise WorkerError("Choose where to save the PDF.")
    if request.get("unique") and os.path.exists(output):  # batch: never replace a file in the folder
        output = unique_path(os.path.dirname(output), os.path.basename(output))
    report = {}
    try:
        doc, sources = build(request.get("sources"), request.get("pages"), request.get("decorations"), report)
        try:
            size = save_atomic(doc, output, bool(request.get("overwrite")), request.get("protect"), close_first=sources,
                               squeeze=request.get("compress"))
            pages = doc.page_count
        finally:
            doc.close()
            for source in sources:
                if not source.is_closed:
                    source.close()
    except PlanError as error:
        raise WorkerError(str(error))
    return {"type": "saved", "path": output, "pages": pages, "size_bytes": size, **report}


def split(request):
    folder = request.get("folder")
    if not isinstance(folder, str) or not os.path.isdir(folder):
        raise WorkerError("Choose a folder for the parts.")
    base = safe_name(request.get("base_name"), "Document")
    try:
        doc, sources = build(request.get("sources"), request.get("pages"), request.get("decorations"))
        try:
            ranges = split_ranges(doc, request.get("mode") or {})
            files = []
            for number, (start, end, title) in enumerate(ranges, 1):
                part = pymupdf.open()
                part.insert_pdf(doc, from_page=start, to_page=end)
                name = f"{base} - {safe_name(title, f'part {number}')}.pdf" if title else f"{base} (part {number}).pdf"
                path = unique_path(folder, name)
                size = save_atomic(part, path, overwrite=False, protect=request.get("protect"))
                part.close()
                files.append({"path": path, "first_page": start + 1, "last_page": end + 1, "size_bytes": size})
        finally:
            doc.close()
            for source in sources:
                source.close()
    except PlanError as error:
        raise WorkerError(str(error))
    return {"type": "split_done", "files": files}


def office_status(_request):
    return {"type": "office_status", **converter.office_status()}


def to_pdf(request):
    inputs, out_dir = request.get("inputs") or [], request.get("out_dir")
    if not isinstance(out_dir, str) or not os.path.isdir(out_dir):
        raise WorkerError("There is no folder for the converted files.")
    converted, failed = [], []
    for path in inputs:
        try:
            pdf = converter.to_pdf(path, out_dir, request.get("page_size") or "image", request.get("profile_dir"))
            converted.append({"input": path, "pdf": pdf})
        except converter.ConvertError as error:
            message = str(error)
            if message == "NO_OFFICE":
                failed.append({"input": path, "error": "No office suite was found to open this file.", "needs_office": True})
            else:
                failed.append({"input": path, "error": message})
    return {"type": "converted", "files": converted, "failed": failed}


def export(request):
    fmt = request.get("format")
    if fmt not in exporter.FORMATS:
        raise WorkerError("Choose a format to export to.")
    output, folder = request.get("output"), request.get("folder")
    if not output and not (folder and os.path.isdir(folder)):
        raise WorkerError("Choose where to save the export.")
    if output and request.get("unique") and os.path.exists(output):  # batch: never replace a file
        output = unique_path(os.path.dirname(output), os.path.basename(output))
    try:
        doc, sources = build(request.get("sources"), request.get("pages"), request.get("decorations"))
    except PlanError as error:
        raise WorkerError(str(error))
    warnings = []
    try:
        if fmt in {"docx", "xlsx", "pptx", "txt", "html", "md"} and not exporter.has_text(doc):
            warnings.append("These pages have no text that can be selected (they look scanned). "
                            "Make them searchable with OCR first for a useful result.")
        name = safe_name(request.get("base_name"), "Document")
        if fmt == "docx":
            files = [{"path": output, "size_bytes": exporter.to_docx(doc, output)}]
        elif fmt == "xlsx":
            size, more = exporter.to_xlsx(doc, output)
            files, warnings = [{"path": output, "size_bytes": size}], warnings + more
        elif fmt == "pptx":
            files = [{"path": output, "size_bytes": exporter.to_pptx(doc, output)}]
        elif fmt in {"png", "jpeg", "tiff"}:
            files = exporter.to_images(doc, fmt, int(request.get("dpi") or 150), output=output, folder=folder, base_name=name)
        elif fmt == "txt":
            files = [{"path": output, "size_bytes": exporter.to_txt(doc, output)}]
        elif fmt == "html":
            files = [{"path": output, "size_bytes": exporter.to_html(doc, output, name)}]
        else:
            files = [{"path": output, "size_bytes": exporter.to_md(doc, output)}]
    except exporter.ExportError as error:
        raise WorkerError(str(error))
    finally:
        doc.close()
        for source in sources:
            source.close()
    return {"type": "exported", "files": files, "warnings": warnings}


def find_text(request):
    """Find & redact: where the words or patterns are on every arranged page, as seen."""
    from .marks import find_on_page

    plan = [{k: v for k, v in entry.items() if k != "marks"} for entry in request.get("pages") or []]
    try:
        doc, sources = build(request.get("sources"), plan)
    except PlanError as error:
        raise WorkerError(str(error))
    try:
        hits = [find_on_page(page, request.get("terms") or [], request.get("patterns") or []) for page in doc]
    finally:
        doc.close()
        for source in sources:
            source.close()
    return {"type": "found", "pages": hits, "total": sum(len(h) for h in hits)}


def page_layer(request):
    entry = dict(request.get("page") or {})
    entry.pop("marks", None)  # the page as it is in the file(s), without unsaved marks
    try:
        doc, sources = build(request.get("sources"), [entry])
    except PlanError as error:
        raise WorkerError(str(error))
    try:
        return {"type": "page_layer", **read_page_layer(doc[0])}
    finally:
        doc.close()
        for source in sources:
            source.close()


COMMANDS = {"ping": ping, "info": info, "apply_plan": apply_plan, "split": split,
            "office_status": office_status, "to_pdf": to_pdf, "export": export,
            "page_layer": page_layer, "find_text": find_text}
