# SPDX-License-Identifier: AGPL-3.0-or-later
"""Builds a new PDF from a page plan: the list of pages the person arranged in the Organise view.

A plan entry is one of
    {"src": 0, "page": 3, "rotate": 90, "crop": [top, right, bottom, left]}   a page of a source file
    {"blank": [595, 842]}                                                     a new blank page (points)
"page" counts from 1. "rotate" is added to the page's own rotation (multiples of 90). "crop" trims
points off each edge *as the page is seen* (after rotation). Sources are opened PDFs:
    [{"path": "...", "password": "...", "title": "..."}]  (password only for protected files, never
    stored; title names the file's bookmark when files are merged)
"""

import os
import re
import uuid

import pymupdf

from .marks import MarkError, add_mark, apply_decorations, edit_text, redact
from .ocr import OcrError, ocr_page

MIN_SIDE = 36  # points (half an inch): the smallest page a crop may leave


class PlanError(Exception):
    """A problem with the request, in plain words."""


def open_source(path, password=None):
    if not isinstance(path, str) or not os.path.isfile(path):
        raise PlanError("A file in this document could not be found. It may have been moved or renamed.")
    try:
        doc = pymupdf.open(path)
    except Exception:
        raise PlanError(f"“{os.path.basename(path)}” could not be opened as a PDF.")
    if not doc.is_pdf:
        doc.close()
        raise PlanError(f"“{os.path.basename(path)}” is not a PDF.")
    if doc.needs_pass and not doc.authenticate(password or ""):
        doc.close()
        raise PlanError(f"The password for “{os.path.basename(path)}” is not correct.")
    return doc


def _visual_to_unrotated(crop, rotation):
    """Map [top, right, bottom, left] as seen on screen to the unrotated page's edges."""
    top, right, bottom, left = crop
    if rotation == 90:  # turned clockwise: the page's left edge is now on top
        return [right, bottom, left, top]
    if rotation == 180:
        return [bottom, left, top, right]
    if rotation == 270:
        return [left, top, right, bottom]
    return [top, right, bottom, left]


def _apply_crop(page, crop):
    if not crop or not any(crop):
        return
    if len(crop) != 4 or any((not isinstance(v, (int, float))) or v < 0 for v in crop):
        raise PlanError("The crop margins must be four numbers of zero or more.")
    top, right, bottom, left = _visual_to_unrotated(crop, page.rotation)
    box = page.cropbox
    new = pymupdf.Rect(box.x0 + left, box.y0 + top, box.x1 - right, box.y1 - bottom)
    if new.width < MIN_SIDE or new.height < MIN_SIDE:
        raise PlanError("The crop margins are larger than the page.")
    page.set_cropbox(new)


def _clean_toc(entries):
    """Make levels valid after some bookmarks were dropped (each level at most one deeper)."""
    cleaned, previous = [], 0
    for level, title, page in entries:
        level = max(1, min(level, previous + 1))
        cleaned.append([level, title, page])
        previous = level
    return cleaned


def build(sources, plan, decorations=None, report=None):
    """Return (new document, opened source documents). The caller saves the result, then closes both.

    Each plan entry may carry "marks" (Phase 3: comments, highlights, added text…, see marks.py).
    `decorations` are whole-document additions: {"form": {...}, "watermark": {...},
    "header_footer": {...}, "flatten": bool, "author": "...", "file_name": "...",
    "ocr": {"languages": [...], "all_pages": bool}, "scrub": bool}.
    `report`, if given, is filled with what was done: OCR pages and words, redactions."""
    if not isinstance(sources, list) or not isinstance(plan, list) or not plan:
        raise PlanError("There are no pages to save.")
    decorations = decorations or {}
    report = report if report is not None else {}
    report.update(ocr_pages=0, ocr_words=0, redactions=0)
    docs = []
    try:
        for source in sources:
            docs.append(open_source(source.get("path"), source.get("password")))
        out = pymupdf.open()
        first_position = {}  # (source, page) -> first page number in the new file
        for entry in plan:
            if "blank" in entry:
                width, height = entry["blank"]
                if not (MIN_SIDE <= width <= 14400 and MIN_SIDE <= height <= 14400):
                    raise PlanError("A blank page has an impossible size.")
                page = out.new_page(-1, width=width, height=height)
            else:
                s, n = entry.get("src"), entry.get("page")
                if not isinstance(s, int) or not 0 <= s < len(docs):
                    raise PlanError("A page refers to a file that is not open.")
                if not isinstance(n, int) or not 1 <= n <= docs[s].page_count:
                    raise PlanError("A page number is outside its file.")
                # final=0 keeps the copy map, so fonts and images shared by pages are copied only once.
                out.insert_pdf(docs[s], from_page=n - 1, to_page=n - 1, final=0)
                page = out[-1]
                first_position.setdefault((s, n), out.page_count)
            rotate = entry.get("rotate", 0) or 0
            if rotate % 90:
                raise PlanError("Pages can only be turned in quarter turns.")
            if rotate:
                page.set_rotation((page.rotation + rotate) % 360)
            _apply_crop(page, entry.get("crop"))
            # Then, all as the page is seen (after rotation and crop), in this order:
            #   OCR text layer → text edits → other marks → redactions, so that a redaction also removes
            #   OCR text, edited text and added content under it.
            marks = entry.get("marks") or []
            try:
                words = ocr_page(page, decorations.get("ocr"))
                if words:
                    report["ocr_pages"] += 1
                    report["ocr_words"] += words
                for mark in marks:
                    if mark.get("type") == "edit_text":
                        edit_text(page, mark)
                for mark in marks:
                    if mark.get("type") not in ("edit_text", "redact"):
                        add_mark(page, mark, decorations.get("author") or "")
                areas = [mark.get("rect") for mark in marks if mark.get("type") == "redact"]
                if areas:
                    left = redact(page, areas)
                    if left:  # never save a redaction that didn't take
                        raise PlanError(f"A redaction on page {out.page_count} could not remove all the text under it. Nothing was saved.")
                    report["redactions"] += len(areas)
            except (MarkError, OcrError) as error:
                raise PlanError(str(error))

        # Bookmarks: keep those whose page is still there, pointing at its new place. When pages
        # come from more than one file, each file gets a top-level bookmark, as Acrobat's Combine does.
        used = sorted({s for (s, _n) in first_position}, key=lambda s: min(p for (t, _), p in first_position.items() if t == s))
        toc = []
        for s in used:
            entries = [[lvl, title, first_position[(s, page)]] for lvl, title, page in docs[s].get_toc(simple=True)
                       if (s, page) in first_position]
            if len(used) > 1:
                start = min(p for (t, _), p in first_position.items() if t == s)
                # "title": the original file's name when this PDF was converted from a Word file or an image.
                name = sources[s].get("title") or os.path.splitext(os.path.basename(sources[s]["path"]))[0]
                toc.append([1, name, start])
                entries = [[lvl + 1, title, page] for lvl, title, page in entries]
            toc.extend(entries)
        if toc:
            out.set_toc(_clean_toc(toc))
        if docs:
            meta = dict(docs[0].metadata or {})
            meta.pop("format", None)
            meta.pop("encryption", None)
            out.set_metadata({k: v for k, v in meta.items() if v is not None})
        try:
            apply_decorations(out, decorations, decorations.get("file_name") or "Document")
        except MarkError as error:
            raise PlanError(str(error))
        return out, docs
    except Exception:
        for doc in docs:
            doc.close()
        raise


def protection_args(protect):
    """Save() arguments for the chosen protection. None or {"mode": "none"} saves without a password."""
    if not protect or protect.get("mode") == "none":
        return {"encryption": pymupdf.PDF_ENCRYPT_NONE}
    if protect.get("mode") != "password":
        raise PlanError("Unknown protection setting.")
    user_pw = protect.get("open_password") or ""
    owner_pw = protect.get("permissions_password") or ""
    restrict = not (protect.get("allow_print", True) and protect.get("allow_copy", True) and protect.get("allow_edit", True))
    if not user_pw and not restrict:
        return {"encryption": pymupdf.PDF_ENCRYPT_NONE}
    if restrict and not owner_pw:
        raise PlanError("Set a permissions password, so the restrictions can't simply be switched off.")
    perms = pymupdf.PDF_PERM_ACCESSIBILITY
    if protect.get("allow_print", True):
        perms |= pymupdf.PDF_PERM_PRINT | pymupdf.PDF_PERM_PRINT_HQ
    if protect.get("allow_copy", True):
        perms |= pymupdf.PDF_PERM_COPY
    if protect.get("allow_edit", True):
        perms |= pymupdf.PDF_PERM_MODIFY | pymupdf.PDF_PERM_ANNOTATE | pymupdf.PDF_PERM_FORM | pymupdf.PDF_PERM_ASSEMBLE
    return {
        "encryption": pymupdf.PDF_ENCRYPT_AES_256,
        "user_pw": user_pw,
        "owner_pw": owner_pw or user_pw,
        "permissions": perms,
    }


COMPRESS = {
    # level: (images above this dpi…, …are resampled to this dpi, JPEG quality, also subset fonts)
    "light": None,                      # only tidy the file: drop unused objects, compress streams
    "medium": (225, 150, 75, False),
    "strong": (150, 100, 60, True),
}


def compress(doc, level):
    """Makes the file smaller. Pictures are only ever made smaller, never larger."""
    if level not in COMPRESS:
        raise PlanError("Unknown compression level.")
    settings = COMPRESS[level]
    if settings:
        threshold, target, quality, fonts = settings
        doc.rewrite_images(dpi_threshold=threshold, dpi_target=target, quality=quality)
        if fonts:
            doc.subset_fonts()


def save_atomic(doc, output, overwrite, protect=None, close_first=(), squeeze=None):
    """Write `doc` to a temporary file next to `output`, then swap it in, so a crash or a full disk
    never leaves a half-written PDF. `close_first`: source documents to close before the swap (on
    Windows an open file can't be replaced, and the output may be one of the sources)."""
    folder = os.path.dirname(os.path.abspath(output)) or "."
    if not os.path.isdir(folder):
        raise PlanError("The folder to save in does not exist.")
    if os.path.exists(output) and not overwrite:
        raise PlanError(f"“{os.path.basename(output)}” already exists.")
    temp = os.path.join(folder, f".{os.path.basename(output)}.aw-{uuid.uuid4().hex[:8]}.tmp")
    try:
        if squeeze:
            compress(doc, squeeze)
            doc.save(temp, garbage=4, deflate=True, clean=True, use_objstms=1, **protection_args(protect))
        else:
            doc.save(temp, garbage=3, deflate=True, **protection_args(protect))
        for other in close_first:
            other.close()
        os.replace(temp, output)
    except PlanError:
        raise
    except PermissionError:
        raise PlanError("The file could not be saved there. It may be open in another program, or the folder is read-only.")
    finally:
        if os.path.exists(temp):
            os.remove(temp)
    return os.path.getsize(output)


def unique_path(folder, name):
    """`name` in `folder`, adding " (2)", " (3)"… so an existing file is never replaced."""
    stem, ext = os.path.splitext(name)
    candidate, n = os.path.join(folder, name), 2
    while os.path.exists(candidate):
        candidate = os.path.join(folder, f"{stem} ({n}){ext}")
        n += 1
    return candidate


def safe_name(text, fallback):
    cleaned = re.sub(r'[\\/:*?"<>|\x00-\x1f]', " ", text or "").strip().strip(".")
    return re.sub(r"\s+", " ", cleaned)[:80] or fallback


def split_ranges(doc, mode):
    """The page ranges (0-based, inclusive) to split into, and a name for each part (or None)."""
    count = doc.page_count
    kind = mode.get("kind")
    if kind == "ranges":
        ranges = []
        for pair in mode.get("ranges") or []:
            a, b = pair
            if not (isinstance(a, int) and isinstance(b, int) and 1 <= a <= b <= count):
                raise PlanError(f"The page range {a}–{b} is outside 1–{count}.")
            ranges.append((a - 1, b - 1, None))
        if not ranges:
            raise PlanError("Enter at least one page range, for example 1-3, 4-10.")
        return ranges
    if kind == "every":
        n = mode.get("pages")
        if not isinstance(n, int) or n < 1:
            raise PlanError("Enter how many pages each part should have.")
        return [(a, min(a + n, count) - 1, None) for a in range(0, count, n)]
    if kind == "bookmarks":
        tops = [(page - 1, title) for level, title, page in doc.get_toc(simple=True) if level == 1 and page >= 1]
        starts = sorted({p: t for p, t in reversed(tops)}.items())
        if not starts:
            raise PlanError("This PDF has no bookmarks to split by.")
        if starts[0][0] != 0:
            starts[0] = (0, starts[0][1])
        ends = [s for s, _ in starts[1:]] + [count]
        return [(s, e - 1, title) for (s, title), e in zip(starts, ends) if e > s]
    if kind == "size":
        limit = mode.get("max_bytes")
        if not isinstance(limit, int) or limit < 10_000:
            raise PlanError("Enter a size limit of at least 0.01 MB.")
        ranges, start = [], 0
        while start < count:
            end = start
            while end + 1 < count:
                trial = pymupdf.open()
                trial.insert_pdf(doc, from_page=start, to_page=end + 1)
                size = len(trial.tobytes(garbage=3, deflate=True))
                trial.close()
                if size > limit:
                    break
                end += 1
            ranges.append((start, end, None))
            start = end + 1
        return ranges
    raise PlanError("Unknown way to split.")
