# SPDX-License-Identifier: AGPL-3.0-or-later
"""Phase 4: OCR, true redaction, Find & redact, Edit text (beta), compression and scrubbing, checked by
reading the saved files back. Run: worker/.venv/bin/python -m unittest discover -s worker/tests"""

import os
import shutil
import tempfile
import unittest

import pymupdf

from test_worker import ask

TEXT = "Certificate of Analysis\nSample FSL/2026/118\nLead (Pb) 0.12 mg/kg\nContact lab.head@example.in\nPhone 98765 43210"


def scan_of(text, rotate=0, dpi=200, html=None):
    """A page that is only a picture of text (a scan). With rotate, the picture is stored turned and the
    page's rotation makes it upright on screen, as real rotated scans are."""
    src = pymupdf.open()
    page = src.new_page()
    page.insert_htmlbox(pymupdf.Rect(60, 60, 540, 500),
                        html or "<div style='font-family:serif;font-size:15pt'>" + text.replace("\n", "<br>") + "</div>")
    page.set_rotation((360 - rotate) % 360)
    pix = page.get_pixmap(dpi=dpi)
    doc = pymupdf.open()
    scan = doc.new_page(width=pix.width * 72 / dpi, height=pix.height * 72 / dpi)
    scan.insert_image(scan.rect, pixmap=pix)
    scan.set_rotation(rotate)
    return doc


class Phase4Tests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.mkdtemp(prefix="aw-p4-")
        self.out = os.path.join(self.folder, "out.pdf")

    def tearDown(self):
        shutil.rmtree(self.folder)

    def path(self, name, doc):
        path = os.path.join(self.folder, name)
        doc.save(path)
        return path

    def save(self, src, pages, decorations=None, **extra):
        (answer,) = ask({"command": "apply_plan", "sources": [{"path": src}], "pages": pages, "output": self.out,
                         "overwrite": True, "decorations": decorations or {}, **extra})
        return answer

    # ----- OCR -----

    def test_ocr_makes_a_scan_searchable_without_changing_its_look(self):
        src = self.path("scan.pdf", scan_of(TEXT))
        with pymupdf.open(src) as doc:
            before = doc[0].get_pixmap(dpi=50).samples
        answer = self.save(src, [{"src": 0, "page": 1}], {"ocr": {"languages": ["eng"]}})
        self.assertEqual(answer["ocr_pages"], 1, answer)
        with pymupdf.open(self.out) as doc:
            page = doc[0]
            self.assertIn("0.12", page.get_text())
            self.assertTrue(page.search_for("Certificate"))
            self.assertEqual(page.get_pixmap(dpi=50).samples, before)  # the scan itself is untouched
        self.assertLess(os.path.getsize(self.out), os.path.getsize(src) * 1.2)

    def test_ocr_on_a_rotated_scan_finds_text_where_it_is_seen(self):
        src = self.path("rot.pdf", scan_of(TEXT, rotate=90))
        self.save(src, [{"src": 0, "page": 1}], {"ocr": {"languages": ["eng"]}})
        with pymupdf.open(self.out) as doc:
            page = doc[0]
            hit = page.search_for("Certificate")[0] * page.rotation_matrix
            self.assertLess(hit.y0, page.rect.height * 0.3)  # near the top as seen, not along a side
            self.assertLess(hit.x0, page.rect.width * 0.3)

    def test_pages_with_text_are_left_alone_unless_asked(self):
        with pymupdf.open() as doc:
            doc.new_page().insert_text((72, 72), "Already text", fontsize=12)
            src = self.path("text.pdf", doc)
        answer = self.save(src, [{"src": 0, "page": 1}], {"ocr": {"languages": ["eng"]}})
        self.assertEqual(answer["ocr_pages"], 0)

    def test_ocr_in_assamese(self):
        src = self.path("asm.pdf", scan_of("", html="<div style='font-size:22pt'>খাদ্য পৰীক্ষাগাৰ প্ৰতিবেদন</div>"))
        answer = self.save(src, [{"src": 0, "page": 1}], {"ocr": {"languages": ["asm"]}})
        self.assertEqual(answer["ocr_pages"], 1, answer)
        with pymupdf.open(self.out) as doc:
            text = doc[0].get_text()
        self.assertTrue(any("ঀ" <= ch <= "৿" for ch in text), text)  # Bengali-script letters

    # ----- Redaction -----

    def text_pdf(self, rotate=0):
        with pymupdf.open() as doc:
            page = doc.new_page()
            page.insert_text((72, 100), "Patient name: Rahul Sharma", fontsize=14)
            page.insert_text((72, 140), "Result: negative", fontsize=14)
            pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 100, 100), False)
            pix.clear_with(40)
            page.insert_image(pymupdf.Rect(72, 300, 272, 500), pixmap=pix)
            note = page.add_text_annot((200, 95), "Name is Rahul Sharma")
            widget = pymupdf.Widget()
            widget.field_type, widget.field_name, widget.rect = pymupdf.PDF_WIDGET_TYPE_TEXT, "Name", pymupdf.Rect(300, 85, 500, 105)
            widget.field_value = "Rahul Sharma"
            page.add_widget(widget)
            page.set_rotation(rotate)
            return self.path(f"private{rotate}.pdf", doc)

    def test_redaction_really_removes_text_pixels_comments_and_fields(self):
        for rotate in (0, 90):
            src = self.text_pdf(rotate)
            with pymupdf.open(src) as doc:
                page = doc[0]
                # One box over the name, its note and the form field, as seen (the page may be turned).
                cover = page.search_for("Rahul Sharma")[0]
                for annot in page.annots():
                    cover |= annot.rect
                for widget in page.widgets():
                    cover |= widget.rect
                cover = cover * page.rotation_matrix
                image_box = page.get_image_rects(page.get_images()[0][0])[0] * page.rotation_matrix
            box = [cover.x0 - 2, cover.y0 - 2, cover.x1 + 2, cover.y1 + 2]
            picture = [image_box.x0, image_box.y0, image_box.x0 + 100, image_box.y0 + 100]
            answer = self.save(src, [{"src": 0, "page": 1, "marks": [{"type": "redact", "rect": box}, {"type": "redact", "rect": picture}]}])
            self.assertEqual(answer["type"], "saved", answer)
            self.assertEqual(answer["redactions"], 2)
            with pymupdf.open(self.out) as doc:
                page = doc[0]
                text = page.get_text()
                self.assertNotIn("Rahul", text, rotate)
                self.assertIn("Result: negative", text)  # the line below stays
                self.assertEqual(list(page.annots()), [])
                self.assertEqual(list(page.widgets()), [])
                raw = open(self.out, "rb").read()
                self.assertNotIn(b"Rahul", raw)  # not anywhere in the file
                # the redacted part of the picture is black, the rest unchanged
                pix = page.get_pixmap(dpi=72)
                corner = pymupdf.Point(picture[0] + 10, picture[1] + 10)
                self.assertEqual(pix.pixel(int(corner.x), int(corner.y)), (0, 0, 0))

    def test_redaction_after_ocr_removes_the_ocr_text_too(self):
        src = self.path("scan2.pdf", scan_of(TEXT))
        # find where "FSL/2026/118" will be, via a first OCR pass
        self.save(src, [{"src": 0, "page": 1}], {"ocr": {"languages": ["eng"]}})
        with pymupdf.open(self.out) as doc:
            box = doc[0].search_for("FSL/2026/118")[0]
        self.save(src, [{"src": 0, "page": 1, "marks": [{"type": "redact", "rect": [box.x0 - 3, box.y0 - 3, box.x1 + 3, box.y1 + 3]}]}],
                  {"ocr": {"languages": ["eng"]}})
        with pymupdf.open(self.out) as doc:
            text = doc[0].get_text()
        self.assertNotIn("FSL/2026/118", text)
        self.assertIn("0.12", text)

    def test_find_words_and_patterns(self):
        with pymupdf.open() as doc:
            page = doc.new_page()
            for y, line in ((100, "Contact lab.head@example.in or 98765 43210"), (130, "Aadhaar 1234 5678 9012 and PAN ABCDE1234F"),
                            (160, "Confidential sample from Rahul")):
                page.insert_text((72, y), line, fontsize=11)
            page.set_rotation(90)
            src = self.path("find.pdf", doc)
        (answer,) = ask({"command": "find_text", "sources": [{"path": src}], "pages": [{"src": 0, "page": 1}],
                         "terms": ["rahul"], "patterns": ["email", "phone", "aadhaar", "pan"]})
        self.assertEqual(answer["type"], "found", answer)
        self.assertGreaterEqual(answer["total"], 5)
        # visual rects: on the turned page, lines run down the page, so boxes are taller than wide
        x0, y0, x1, y1 = answer["pages"][0][0]
        self.assertGreater(y1 - y0, x1 - x0)

    # ----- Edit text (beta) -----

    def test_edit_one_line_keeps_the_others(self):
        with pymupdf.open() as doc:
            page = doc.new_page()
            page.insert_text((72, 100), "Lead (Pb): 0.12 mg/kg", fontsize=12, fontname="helv")
            page.insert_text((72, 116), "Cadmium (Cd): 0.05 mg/kg", fontsize=12, fontname="helv")
            src = self.path("edit.pdf", doc)
        (layer,) = ask({"command": "page_layer", "sources": [{"path": src}], "page": {"src": 0, "page": 1}})
        line = next(l for l in layer["lines"] if l["text"].startswith("Lead"))
        self.assertEqual(line["font"], "sans")
        self.assertAlmostEqual(line["size"], 12, delta=0.5)
        mark = {"type": "edit_text", **{k: line[k] for k in ("rect", "size", "color", "bold", "italic", "font")}, "text": "Lead (Pb): 0.10 mg/kg"}
        self.save(src, [{"src": 0, "page": 1, "marks": [mark]}])
        with pymupdf.open(self.out) as doc:
            text = doc[0].get_text()
        self.assertIn("0.10 mg/kg", text)
        self.assertNotIn("0.12", text)
        self.assertIn("Cadmium (Cd): 0.05 mg/kg", text)

    # ----- Compress and scrub -----

    def test_compress_shrinks_big_pictures(self):
        with pymupdf.open() as doc:
            page = doc.new_page()
            pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 2400, 2400), False)  # 600 dpi over 4 inches
            for i in range(0, 2400, 40):
                pix.set_rect(pymupdf.IRect(i, 0, i + 20, 2400), (i % 255, 120, 200))
            page.insert_image(pymupdf.Rect(72, 72, 360, 360), pixmap=pix)
            page.insert_text((72, 400), "Kept text", fontsize=12)
            src = self.path("big.pdf", doc)
        original = os.path.getsize(src)
        sizes = {}
        for level in ("light", "medium", "strong"):
            answer = self.save(src, [{"src": 0, "page": 1}], compress=level)
            self.assertEqual(answer["type"], "saved", answer)
            sizes[level] = answer["size_bytes"]
            with pymupdf.open(self.out) as doc:
                self.assertIn("Kept text", doc[0].get_text())
        self.assertLess(sizes["medium"], original * 0.5)
        self.assertLessEqual(sizes["strong"], sizes["medium"])

    def test_scrub_removes_metadata_but_keeps_ocr_text(self):
        doc = scan_of(TEXT)
        doc.set_metadata({"author": "Private Person", "title": "Secret"})
        src = self.path("meta.pdf", doc)
        self.save(src, [{"src": 0, "page": 1}], {"ocr": {"languages": ["eng"]}, "scrub": True})
        with pymupdf.open(self.out) as out:
            self.assertFalse(out.metadata.get("author"))
            self.assertIn("0.12", out[0].get_text())

    def test_batch_output_never_replaces_a_file(self):
        with pymupdf.open() as doc:
            doc.new_page().insert_text((72, 72), "x")
            src = self.path("one.pdf", doc)
        shutil.copy(src, self.out)
        answer = self.save(src, [{"src": 0, "page": 1}], unique=True, overwrite=False)
        self.assertTrue(answer["path"].endswith("out (2).pdf"), answer)


if __name__ == "__main__":
    unittest.main()
