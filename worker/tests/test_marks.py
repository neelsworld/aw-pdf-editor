# SPDX-License-Identifier: AGPL-3.0-or-later
"""Phase 3: mark-up, forms, watermark, header/footer and flatten, checked by reading the saved file.
Positions are given as seen on screen; the tests check them on rotated and cropped pages too.
Run: worker/.venv/bin/python -m unittest discover -s worker/tests  (from desktop/)."""

import base64
import io
import os
import shutil
import tempfile
import unittest

import pymupdf
from PIL import Image

from test_worker import ask


def visual(page, rect):
    return pymupdf.Rect(rect) * page.rotation_matrix


def close_to(a, b, tolerance=3):
    return all(abs(x - y) <= tolerance for x, y in zip(pymupdf.Rect(a), pymupdf.Rect(b)))


class MarkTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.mkdtemp(prefix="aw-marks-")
        self.src = os.path.join(self.folder, "Report.pdf")
        with pymupdf.open() as doc:
            for n in (1, 2, 3):
                page = doc.new_page()
                page.insert_text((72, 100), f"Lead result page {n}", fontsize=14)
                page.insert_text((72, 140), "Moisture 4.2 percent", fontsize=14)
            page = doc[0]
            for kind, name, rect, extra in (
                (pymupdf.PDF_WIDGET_TYPE_TEXT, "Sample_ID", (72, 200, 260, 220), None),
                (pymupdf.PDF_WIDGET_TYPE_CHECKBOX, "Passed", (72, 240, 86, 254), None),
                (pymupdf.PDF_WIDGET_TYPE_COMBOBOX, "Method", (72, 270, 260, 290), ["AOAC", "IS 1155"]),
            ):
                widget = pymupdf.Widget()
                widget.field_type, widget.field_name, widget.rect = kind, name, pymupdf.Rect(rect)
                if extra:
                    widget.choice_values, widget.field_value = extra, extra[0]
                page.add_widget(widget)
            doc.save(self.src)
        self.out = os.path.join(self.folder, "out.pdf")

    def tearDown(self):
        shutil.rmtree(self.folder)

    def save(self, pages, decorations=None):
        (answer,) = ask({"command": "apply_plan", "sources": [{"path": self.src}], "pages": pages,
                         "output": self.out, "overwrite": True, "decorations": decorations or {}})
        self.assertEqual(answer["type"], "saved", answer)
        return pymupdf.open(self.out)

    def test_annotations_land_where_drawn_on_rotated_and_cropped_pages(self):
        box = [100, 50, 220, 110]
        for rotate in (0, 90, 180, 270):
            for crop in (None, [20, 30, 40, 10]):
                entry = {"src": 0, "page": 2, "rotate": rotate, "crop": crop,
                         "marks": [{"type": "rect", "rect": box, "color": [0, 0, 1], "width": 2}]}
                with self.save([entry]) as doc:
                    page = doc[0]  # keep the page alive while its annotations are used (PyMuPDF)
                    annot = next(page.annots())
                    self.assertTrue(close_to(visual(page, annot.rect), box), (rotate, crop, visual(page, annot.rect)))

    def test_every_annotation_kind(self):
        marks = [
            {"type": "highlight", "rect": [70, 85, 300, 105], "comment": "check this"},
            {"type": "underline", "rect": [70, 125, 300, 145]},
            {"type": "strikeout", "rect": [70, 125, 150, 145]},
            {"type": "note", "at": [400, 100], "text": "Repeat the test"},
            {"type": "ellipse", "rect": [300, 300, 400, 360]},
            {"type": "line", "from": [100, 400], "to": [300, 400]},
            {"type": "arrow", "from": [100, 450], "to": [300, 500]},
            {"type": "ink", "paths": [[[100, 600], [150, 620], [200, 600]]]},
            {"type": "stamp", "rect": [350, 650, 550, 720], "title": "Reviewed", "detail": "Neel K · 02 Nov 2026"},
        ]
        with self.save([{"src": 0, "page": 2, "marks": marks}], {"author": "Neel K"}) as doc:
            page = doc[0]
            annots = list(page.annots())
            self.assertEqual([a.type[1] for a in annots], ["Highlight", "Underline", "StrikeOut", "Text", "Circle", "Line", "Line", "Ink", "Stamp"])
            highlight = annots[0]
            self.assertEqual(highlight.info["title"], "Neel K")
            self.assertEqual(highlight.info["content"], "check this")
            # The highlight covers the words, not the whole drawn box.
            self.assertIn("Lead result page 2", page.get_textbox(highlight.rect))
            stamp = annots[-1]
            self.assertIn("REVIEWED", stamp.info["content"])

    def test_highlight_over_a_picture_still_marks_the_area(self):
        with self.save([{"src": 0, "page": 1, "marks": [{"type": "highlight", "rect": [300, 500, 400, 550]}]}]) as doc:
            page = doc[0]
            self.assertEqual([a.type[1] for a in page.annots()], ["Square"])

    def test_added_text_and_picture_are_page_content(self):
        picture = io.BytesIO()
        Image.new("RGB", (60, 30), "green").save(picture, "PNG")
        marks = [{"type": "text", "rect": [100, 300, 400, 340], "text": "Sample received 02/11/2026", "size": 14},
                 {"type": "image", "rect": [100, 400, 220, 460], "data": base64.b64encode(picture.getvalue()).decode()}]
        with self.save([{"src": 0, "page": 2, "rotate": 90, "marks": marks}]) as doc:
            page = doc[0]
            self.assertEqual(list(page.annots()), [])
            self.assertIn("Sample received 02/11/2026", page.get_text())
            image_rect = page.get_image_rects(page.get_images()[0][0])[0]
            self.assertTrue(close_to(visual(page, image_rect), [100, 400, 220, 460]))

    def test_marks_on_a_blank_page(self):
        with self.save([{"blank": [595, 842], "marks": [{"type": "text", "rect": [50, 50, 300, 80], "text": "Notes"}]}]) as doc:
            self.assertIn("Notes", doc[0].get_text())

    def test_form_values_by_name(self):
        values = {"Sample_ID": "FSL/2026/118", "Passed": True, "Method": "IS 1155"}
        with self.save([{"src": 0, "page": 1}], {"form": values}) as doc:
            page = doc[0]
            fields = {w.field_name: w.field_value for w in page.widgets()}
        self.assertEqual(fields["Sample_ID"], "FSL/2026/118")
        self.assertEqual(fields["Method"], "IS 1155")
        self.assertNotEqual(fields["Passed"], "Off")

    def test_flatten_keeps_the_look_but_removes_fields_and_comments(self):
        decorations = {"form": {"Sample_ID": "FSL/2026/118"}, "flatten": True}
        with self.save([{"src": 0, "page": 1, "marks": [{"type": "note", "at": [400, 100], "text": "x"}]}], decorations) as doc:
            page = doc[0]
            self.assertEqual(list(page.widgets()), [])
            self.assertEqual(list(page.annots()), [])
            self.assertIn("FSL/2026/118", page.get_text())

    def test_watermark_and_page_numbers_on_every_page(self):
        decorations = {"watermark": {"text": "CONFIDENTIAL"},
                       "header_footer": {"items": [{"pos": "bottom-center", "text": "Page {n} of {N}"},
                                                   {"pos": "top-right", "text": "{file}"}]},
                       "file_name": "Report"}
        pages = [{"src": 0, "page": n, "rotate": r} for n, r in ((1, 0), (2, 90), (3, 0))]
        with self.save(pages, decorations) as doc:
            for index, page in enumerate(doc, 1):
                text = page.get_text()
                self.assertIn(f"Page {index} of 3", text)
                self.assertIn("Report", text)
                self.assertIn("CONFIDENTIAL", text)
            # The footer sits at the bottom of the page as seen, also on the turned page.
            turned = doc[1]
            footer = turned.search_for("Page 2 of 3")[0]
            self.assertGreater(visual(turned, footer).y0, turned.rect.height * 0.85)

    def test_numbering_can_skip_a_cover_and_start_later(self):
        decorations = {"header_footer": {"items": [{"pos": "bottom-right", "text": "{n}/{N}"}], "skip_first": 1, "start": 1}}
        with self.save([{"src": 0, "page": n} for n in (1, 2, 3)], decorations) as doc:
            self.assertNotIn("1/2", doc[0].get_text())
            self.assertIn("1/2", doc[1].get_text())
            self.assertIn("2/2", doc[2].get_text())

    def test_page_layer_gives_words_fields_and_comments_as_seen(self):
        (layer,) = ask({"command": "page_layer", "sources": [{"path": self.src}], "page": {"src": 0, "page": 1, "rotate": 90}})
        self.assertEqual(layer["type"], "page_layer", layer)
        self.assertIn("Lead", [w[4] for w in layer["words"]])
        names = {f["name"]: f for f in layer["fields"]}
        self.assertEqual(names["Method"]["choices"], ["AOAC", "IS 1155"])
        self.assertEqual(names["Passed"]["type"], "checkbox")
        # Turned a quarter: the 188-point wide text field is now 188 points high.
        x0, y0, x1, y1 = names["Sample_ID"]["rect"]
        self.assertAlmostEqual(y1 - y0, 188, delta=1)

    def test_unknown_mark_is_a_plain_error(self):
        (answer,) = ask({"command": "apply_plan", "sources": [{"path": self.src}], "output": self.out, "overwrite": True,
                         "pages": [{"src": 0, "page": 1, "marks": [{"type": "explode", "rect": [0, 0, 1, 1]}]}]})
        self.assertEqual(answer["type"], "error")

    def test_export_includes_marks_and_additions(self):
        txt = os.path.join(self.folder, "out.txt")
        (answer,) = ask({"command": "export", "format": "txt", "sources": [{"path": self.src}], "output": txt,
                         "pages": [{"src": 0, "page": 1, "marks": [{"type": "text", "rect": [72, 400, 400, 430], "text": "Checked by QA"}]}],
                         "decorations": {"header_footer": {"items": [{"pos": "bottom-center", "text": "Page {n}"}]}}})
        self.assertEqual(answer["type"], "exported", answer)
        with open(txt, encoding="utf-8") as handle:
            text = handle.read()
        self.assertIn("Checked by QA", text)
        self.assertIn("Page 1", text)


if __name__ == "__main__":
    unittest.main()
