# SPDX-License-Identifier: AGPL-3.0-or-later
"""Mark-up and additions (Phase 3): what the person drew or typed on a page, written into the PDF.

Every mark is given in *visual* points: as the page is seen on screen, after its rotation and crop,
origin at the top-left. Two conversions, both checked for every rotation, with and without crop
(tests/test_marks.py):
  - annotations (comments, highlights, shapes, ink, stamps): rect * page.derotation_matrix;
  - page content (added text, images, watermark, page numbers): the page is drawn on while
    temporarily unrotated and uncropped, at mediabox coordinates from to_media(). PyMuPDF misplaces
    content on pages that are both rotated and cropped otherwise.

Comments, highlights, shapes, ink and stamps become standard PDF annotations (movable and editable in
Acrobat). Added text, pictures, watermarks and page numbers become part of the page itself, because
MuPDF shapes Assamese, Bengali and Hindi correctly only in page content.
"""

import base64
import datetime
import html

import pymupdf


class MarkError(Exception):
    """A problem with a mark, in plain words."""


# ---------- Coordinates ----------

def _rect(values):
    if not isinstance(values, (list, tuple)) or len(values) != 4:
        raise MarkError("A mark has no valid position.")
    return pymupdf.Rect(*values).normalize()


def _point(values):
    if not isinstance(values, (list, tuple)) or len(values) != 2:
        raise MarkError("A mark has no valid position.")
    return pymupdf.Point(*values)


def to_annot(page, rect_or_point):
    return rect_or_point * page.derotation_matrix


def to_visual(page, rect):
    return pymupdf.Rect(rect) * page.rotation_matrix


def to_media(page, rect):
    """Visual rect → mediabox coordinates on the unrotated, uncropped page (see Flat)."""
    rot, crop = page.rotation, page.cropbox
    width, height = crop.width, crop.height

    def point(u, v):
        if rot == 90:
            x, y = v, height - u
        elif rot == 180:
            x, y = width - u, height - v
        elif rot == 270:
            x, y = width - v, u
        else:
            x, y = u, v
        return x + crop.x0, y + crop.y0

    a, b = point(rect.x0, rect.y0), point(rect.x1, rect.y1)
    return pymupdf.Rect(min(a[0], b[0]), min(a[1], b[1]), max(a[0], b[0]), max(a[1], b[1]))


def on_page(page, visual_rect, draw):
    """Draws page content at `visual_rect`: calls draw(flat_page, mediabox_rect, rotation). The target
    and rotation are worked out *before* the page is flattened; inside Flat they would read 0."""
    target, rotation = to_media(page, visual_rect), page.rotation
    with Flat(page) as flat:
        draw(flat, target, rotation)


class Flat:
    """Temporarily unrotate and uncrop a page to draw content on it at mediabox coordinates.
    Use on_page(); don't read page.rotation, page.rect or to_media() inside this block."""

    def __init__(self, page):
        self.page = page

    def __enter__(self):
        self.rotation, self.crop = self.page.rotation, pymupdf.Rect(self.page.cropbox)
        self.page.set_rotation(0)
        self.page.set_cropbox(self.page.mediabox)
        return self.page

    def __exit__(self, *_):
        self.page.set_cropbox(self.crop)
        self.page.set_rotation(self.rotation)


# ---------- Small helpers ----------

def _colour(values, default=(0, 0, 0)):
    if not isinstance(values, (list, tuple)) or len(values) != 3:
        return default
    return tuple(max(0.0, min(1.0, float(v))) for v in values)


def _css_colour(rgb):
    return "#%02x%02x%02x" % tuple(round(c * 255) for c in rgb)


def _text_html(text, size, colour, bold=False, align="left"):
    escaped = html.escape(text or "").replace("\n", "<br>")
    weight = "bold" if bold else "normal"
    return (f"<div style='font-family: sans-serif; font-size: {size}pt; font-weight: {weight}; "
            f"color: {_css_colour(colour)}; text-align: {align}; line-height: 1.25'>{escaped}</div>")


def _label(annot, mark, author):
    info = {"title": author or ""}
    if mark.get("comment"):
        info["content"] = mark["comment"]
    annot.set_info(**info)


# ---------- Reading a page: words, form fields and existing annotations, in visual points ----------

def page_layer(page):
    words = [[round(v, 1) for v in to_visual(page, w[:4])] + [w[4]] for w in page.get_text("words")]
    fields = []
    for widget in page.widgets() or []:
        if widget.field_type in (pymupdf.PDF_WIDGET_TYPE_BUTTON, pymupdf.PDF_WIDGET_TYPE_SIGNATURE):
            continue
        field = {
            "name": widget.field_name, "type": widget.field_type_string.lower(),
            "rect": [round(v, 1) for v in to_visual(page, widget.rect)],
            "value": widget.field_value, "read_only": bool(widget.field_flags & 1),
        }
        if widget.field_type in (pymupdf.PDF_WIDGET_TYPE_COMBOBOX, pymupdf.PDF_WIDGET_TYPE_LISTBOX):
            field["choices"] = [c if isinstance(c, str) else c[1] for c in (widget.choice_values or [])]
        if widget.field_type in (pymupdf.PDF_WIDGET_TYPE_CHECKBOX, pymupdf.PDF_WIDGET_TYPE_RADIOBUTTON):
            field["on"] = widget.on_state()
        fields.append(field)
    annots = []
    for annot in page.annots() or []:
        info = annot.info
        annots.append({"type": annot.type[1], "rect": [round(v, 1) for v in to_visual(page, annot.rect)],
                       "content": info.get("content", ""), "author": info.get("title", "")})
    return {"words": words, "fields": fields, "annots": annots, "lines": text_lines(page)}


def _family(font):
    name = (font or "").lower()
    if any(k in name for k in ("courier", "mono", "consol")):
        return "mono"
    if any(k in name for k in ("times", "serif", "roman", "georgia", "garamond", "cambria", "book", "minion", "charis")) and "sans" not in name:
        return "serif"
    return "sans"


def text_lines(page):
    """Lines of text as seen, with their look, for Edit text (Phase 4 beta)."""
    lines = []
    for block in page.get_text("dict")["blocks"]:
        if block.get("type") != 0:
            continue
        for line in block["lines"]:
            spans = [s for s in line["spans"] if s["text"].strip()]
            if not spans:
                continue
            first = max(spans, key=lambda s: len(s["text"]))  # the span that sets the line's look
            lines.append({
                "rect": [round(v, 1) for v in to_visual(page, line["bbox"])],
                "text": "".join(s["text"] for s in line["spans"]).strip(),
                "size": round(first["size"], 1),
                "color": [((first["color"] >> 16) & 255) / 255, ((first["color"] >> 8) & 255) / 255, (first["color"] & 255) / 255],
                "bold": bool(first["flags"] & 16) or "bold" in first["font"].lower(),
                "italic": bool(first["flags"] & 2) or "italic" in first["font"].lower(),
                "font": _family(first["font"]),
                "dir": [round(v, 3) for v in line["dir"]],
            })
    return lines


# ---------- Finding text to redact (Phase 4) ----------

PATTERNS = {
    "email": r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+",
    "phone": r"(?:\+91[\s-]?)?\b[6-9]\d{4}[\s-]?\d{5}\b",          # Indian mobile numbers
    "aadhaar": r"\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b",                   # 12 digits, in fours or together
    "pan": r"\b[A-Z]{5}\d{4}[A-Z]\b",                                # PAN card number
}


def find_on_page(page, terms=(), patterns=()):
    """Where the words or patterns are on the page, as visual rects (for Find & redact)."""
    import re

    found = []
    for term in terms:
        term = term.strip()
        if term:
            found.extend(page.search_for(term))
    if patterns:
        text = page.get_text("text")
        for name in patterns:
            regex = PATTERNS.get(name)
            if not regex:
                continue
            for match in {m.group(0) for m in re.finditer(regex, text)}:
                found.extend(page.search_for(match))
    unique = {tuple(round(v, 1) for v in to_visual(page, r)) for r in found}
    return [list(r) for r in sorted(unique, key=lambda r: (r[1], r[0]))]


# ---------- True redaction (Phase 4) ----------

def redact(page, rects):
    """Removes everything under the rects for good: text, image pixels, drawings fully inside, and
    any comment or form field touching them (their text would survive otherwise). Painted black.
    Returns the rects where text could still be found afterwards (should be none)."""
    if not rects:
        return []
    rects = [_rect(r) for r in rects]
    for rect in rects:
        page.add_redact_annot(to_annot(page, rect), fill=(0, 0, 0))
    page.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_PIXELS, graphics=pymupdf.PDF_REDACT_LINE_ART_REMOVE_IF_COVERED,
                          text=pymupdf.PDF_REDACT_TEXT_REMOVE)
    touching = lambda r: any(to_visual(page, r).intersects(v) for v in rects)
    for annot in [a for a in page.annots() or [] if touching(a.rect)]:
        page.delete_annot(annot)
    for widget in [w for w in page.widgets() or [] if touching(w.rect)]:
        page.delete_widget(widget)
    # Shrink by a hair: a neighbouring letter that only touches the edge is not "under" the box.
    return [r for r in rects if page.get_textbox(to_annot(page, r + (1, 1, -1, -1))).strip()]


def scrub_hidden(doc):
    """Removes information people don't see: metadata, attachments, scripts, thumbnails. Keeps form
    values and invisible OCR text (that's what makes a scan searchable)."""
    doc.scrub(attached_files=True, clean_pages=True, embedded_files=True, hidden_text=False, javascript=True,
              metadata=True, redactions=False, remove_links=False, reset_fields=False, reset_responses=True,
              thumbnails=True, xml_metadata=True)


# ---------- Edit existing text (Phase 4 beta) ----------

def edit_text(page, mark):
    """Replaces one line: its old text is removed (only the text: pictures and lines stay), and the new
    text is written in the same place, size, colour and style. Short corrections work best."""
    rect = _rect(mark.get("rect"))
    inset = rect.height * 0.15  # stay clear of the lines above and below
    page.add_redact_annot(to_annot(page, rect + (0, inset, 0, -inset)), fill=False)
    page.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE, graphics=pymupdf.PDF_REDACT_LINE_ART_NONE,
                          text=pymupdf.PDF_REDACT_TEXT_REMOVE)
    text = (mark.get("text") or "").strip()
    if not text:
        return
    size = max(4, min(96, float(mark.get("size") or 11)))
    family = {"serif": "serif", "mono": "monospace"}.get(mark.get("font"), "sans-serif")
    style = (f"font-family: {family}; font-size: {size}pt; color: {_css_colour(_colour(mark.get('color')))}; "
             f"font-weight: {'bold' if mark.get('bold') else 'normal'}; font-style: {'italic' if mark.get('italic') else 'normal'}; "
             "white-space: nowrap; line-height: 1")
    content = f"<div style='{style}'>{html.escape(text)}</div>"
    # Room to grow to the right if the new text is longer; it shrinks only if it still doesn't fit.
    target = pymupdf.Rect(rect.x0, rect.y0 - size * 0.15, max(rect.x1, page.rect.width - 12), rect.y1 + size * 0.3)
    on_page(page, target, lambda flat, box, rotation: flat.insert_htmlbox(box, content, rotate=rotation, scale_low=0))


# ---------- Writing marks ----------

def _text_markup(page, mark, colour):
    area = _rect(mark.get("rect"))
    quads = []
    for word in page.get_text("words"):
        if to_visual(page, word[:4]).intersects(area):
            quads.append(pymupdf.Rect(word[:4]).quad)
    kind = mark["type"]
    if not quads:  # nothing to underline: a highlight over an area still works, the others don't
        if kind != "highlight":
            return None
        annot = page.add_rect_annot(to_annot(page, area))
        annot.set_colors(stroke=None, fill=colour)
        annot.set_border(width=0)
        annot.set_opacity(0.35)
        return annot
    add = {"highlight": page.add_highlight_annot, "underline": page.add_underline_annot,
           "strikeout": page.add_strikeout_annot}[kind]
    annot = add(quads=quads)
    annot.set_colors(stroke=colour)
    return annot


def _stamp(page, mark, colour):
    """A stamp annotation (movable in Acrobat) whose look is drawn here: a rounded border, the title
    in bold capitals and an optional details line (name, date), in any script. The picture is turned
    against the page's rotation so the stamp reads upright as the page is seen."""
    rect = _rect(mark.get("rect"))
    title = html.escape((mark.get("title") or "REVIEWED").upper())
    detail = html.escape(mark.get("detail") or "")
    sheet_doc = pymupdf.open()
    sheet = sheet_doc.new_page(width=rect.width, height=rect.height)
    sheet.draw_rect(sheet.rect + (2, 2, -2, -2), color=colour, width=2.5, radius=0.08)
    title_size = rect.height * (0.36 if detail else 0.5)
    content = (f"<div style='text-align:center; color:{_css_colour(colour)}; font-family:sans-serif'>"
               f"<div style='font-size:{title_size:.1f}pt; font-weight:bold'>{title}</div>"
               + (f"<div style='font-size:{rect.height * 0.17:.1f}pt'>{detail}</div>" if detail else "") + "</div>")
    sheet.insert_htmlbox(sheet.rect + (6, 4, -6, -4), content, scale_low=0)
    sheet.set_rotation((360 - page.rotation) % 360)
    picture = sheet.get_pixmap(dpi=200, alpha=True)
    sheet_doc.close()
    annot = page.add_stamp_annot(to_annot(page, rect), stamp=picture)
    annot.set_info(content=(mark.get("title") or "REVIEWED").upper() + (f" — {mark.get('detail')}" if detail else ""))
    return annot


def add_mark(page, mark, author=""):
    kind = mark.get("type")
    colour = _colour(mark.get("color"), (0.96, 0.77, 0.19) if kind == "highlight" else (0.85, 0.1, 0.1))
    width = max(0.5, min(12.0, float(mark.get("width") or 2)))
    annot = None
    if kind in ("highlight", "underline", "strikeout"):
        annot = _text_markup(page, mark, colour)
    elif kind == "note":
        annot = page.add_text_annot(to_annot(page, _point(mark.get("at"))), mark.get("text") or "", icon="Comment")
        annot.set_colors(stroke=colour)
        annot.set_info(content=mark.get("text") or "", title=author or "")
        annot.update()
        return
    elif kind in ("rect", "ellipse"):
        rect = to_annot(page, _rect(mark.get("rect")))
        annot = page.add_rect_annot(rect) if kind == "rect" else page.add_circle_annot(rect)
        annot.set_colors(stroke=colour, fill=_colour(mark["fill"]) if mark.get("fill") else None)
        annot.set_border(width=width)
    elif kind in ("line", "arrow"):
        annot = page.add_line_annot(to_annot(page, _point(mark.get("from"))), to_annot(page, _point(mark.get("to"))))
        annot.set_colors(stroke=colour, fill=colour)
        annot.set_border(width=width)
        if kind == "arrow":
            annot.set_line_ends(pymupdf.PDF_ANNOT_LE_NONE, pymupdf.PDF_ANNOT_LE_CLOSED_ARROW)
    elif kind == "ink":
        strokes = [[to_annot(page, _point(p)) for p in stroke] for stroke in mark.get("paths") or [] if len(stroke) > 1]
        if not strokes:
            return
        annot = page.add_ink_annot([[(p.x, p.y) for p in stroke] for stroke in strokes])
        annot.set_colors(stroke=colour)
        annot.set_border(width=width)
    elif kind == "stamp":
        annot = _stamp(page, mark, colour)
    elif kind == "text":
        rect = _rect(mark.get("rect"))
        size = max(4, min(96, float(mark.get("size") or 12)))
        content = _text_html(mark.get("text"), size, _colour(mark.get("color")), mark.get("bold"))
        on_page(page, rect, lambda flat, target, rotation: flat.insert_htmlbox(target, content, rotate=rotation, scale_low=0))
        return
    elif kind == "image":
        try:
            data = base64.b64decode(mark.get("data") or "", validate=True)
        except Exception:
            raise MarkError("A picture on the page could not be read.")
        on_page(page, _rect(mark.get("rect")), lambda flat, target, rotation:
                flat.insert_image(target, stream=data, rotate=rotation, keep_proportion=False))
        return
    else:
        raise MarkError(f"Unknown kind of mark: {kind!r}.")
    if annot is not None:
        _label(annot, mark, author)
        annot.update()


# ---------- Whole-document additions ----------

def _fill(template, number, total, file_name):
    today = datetime.date.today().strftime("%d %b %Y")
    return (template.replace("{n}", str(number)).replace("{N}", str(total))
            .replace("{date}", today).replace("{file}", file_name))


def add_watermark(doc, wm):
    text = (wm.get("text") or "").strip()
    if not text:
        return
    colour = _colour(wm.get("color"), (0.75, 0.1, 0.1))
    opacity = max(0.05, min(1.0, float(wm.get("opacity") or 0.18)))
    angle = float(wm.get("angle") if wm.get("angle") is not None else 45)
    # Draw the words once on a scratch page (MuPDF shapes Indian scripts there), then place that
    # page, turned, on every page.
    stamp = pymupdf.open()
    sheet = stamp.new_page(width=1000, height=200)
    sheet.insert_htmlbox(sheet.rect, _text_html(text, 96, colour, bold=True, align="center"), opacity=opacity, scale_low=0)
    for page in doc:
        # The whole visible page; show_pdf_page turns the words and shrinks them to fit inside it.
        on_page(page, page.rect, lambda flat, target, rotation:
                flat.show_pdf_page(target, stamp, 0, rotate=angle + rotation, keep_proportion=True))
    stamp.close()


POSITIONS = {"top-left", "top-center", "top-right", "bottom-left", "bottom-center", "bottom-right"}


def add_header_footer(doc, hf, file_name):
    items = [i for i in hf.get("items") or [] if i.get("pos") in POSITIONS and (i.get("text") or "").strip()]
    if not items:
        return
    size = max(5, min(24, float(hf.get("size") or 9)))
    margin = max(2, min(60, float(hf.get("margin_mm") or 10))) * 72 / 25.4
    first = int(hf.get("start") or 1)
    skip = int(hf.get("skip_first") or 0)
    colour = _colour(hf.get("color"), (0.2, 0.2, 0.2))
    total = doc.page_count - skip + first - 1
    for index, page in enumerate(doc):
        if index < skip:
            continue
        number = index - skip + first
        visual = page.rect
        height = size * 1.6
        for item in items:
            vert, horiz = item["pos"].split("-")
            y0 = margin if vert == "top" else visual.height - margin - height
            box = pymupdf.Rect(margin, y0, visual.width - margin, y0 + height)
            align = {"left": "left", "center": "center", "right": "right"}[horiz]
            content = _text_html(_fill(item["text"], number, total, file_name), size, colour, align=align)
            on_page(page, box, lambda flat, target, rotation: flat.insert_htmlbox(target, content, rotate=rotation, scale_low=0))


def fill_form(doc, values):
    """Sets form fields by name (fields with the same name share a value, as in any PDF reader)."""
    if not values:
        return 0
    changed = 0
    for page in doc:
        for widget in page.widgets() or []:
            if widget.field_name not in values:
                continue
            value = values[widget.field_name]
            if widget.field_type == pymupdf.PDF_WIDGET_TYPE_CHECKBOX:
                widget.field_value = widget.on_state() if value in (True, "true", "on", widget.on_state()) else "Off"
            elif widget.field_type == pymupdf.PDF_WIDGET_TYPE_RADIOBUTTON:
                widget.field_value = widget.on_state() if value == widget.on_state() else "Off"
            else:
                widget.field_value = "" if value is None else str(value)
            widget.update()
            changed += 1
    return changed


def apply_decorations(doc, decorations, file_name="Document"):
    """Whole-document additions, in this order: form values, watermark, header/footer, flatten."""
    if not decorations:
        return
    fill_form(doc, decorations.get("form") or {})
    if decorations.get("watermark"):
        add_watermark(doc, decorations["watermark"])
    if decorations.get("header_footer"):
        add_header_footer(doc, decorations["header_footer"], file_name)
    if decorations.get("flatten"):
        doc.bake(annots=True, widgets=True)
    if decorations.get("scrub"):
        scrub_hidden(doc)
