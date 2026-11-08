# SPDX-License-Identifier: AGPL-3.0-or-later
"""Phase 2: Create PDF and Export PDF, checked by reading the results back.
Run: worker/.venv/bin/python -m unittest discover -s worker/tests  (from desktop/).
The office tests run only when LibreOffice (or Microsoft Office on Windows) is installed."""

import os
import shutil
import tempfile
import unittest

import pymupdf
from PIL import Image

from test_worker import ask

HAS_OFFICE = bool(ask({"command": "office_status"})[0].get("libreoffice"))


def page_texts(path):
    with pymupdf.open(path) as doc:
        return [page.get_text().strip() for page in doc]


class CreateTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.mkdtemp(prefix="aw-create-")
        self.out = os.path.join(self.folder, "converted")
        os.mkdir(self.out)

    def tearDown(self):
        shutil.rmtree(self.folder)

    def convert(self, *paths, **extra):
        (answer,) = ask({"command": "to_pdf", "inputs": list(paths), "out_dir": self.out, **extra})
        self.assertEqual(answer["type"], "converted", answer)
        return answer

    def test_photo_is_turned_upright_from_its_exif(self):
        # A 400×200 landscape picture stored with "rotate 90°" in EXIF: upright it is portrait.
        photo = os.path.join(self.folder, "photo.jpg")
        exif = Image.Exif()
        exif[0x0112] = 6
        Image.new("RGB", (400, 200), "red").save(photo, exif=exif, dpi=(72, 72))
        pdf = self.convert(photo)["files"][0]["pdf"]
        with pymupdf.open(pdf) as doc:
            self.assertEqual((round(doc[0].rect.width), round(doc[0].rect.height)), (200, 400))

    def test_images_fit_on_a4_and_landscape_gets_landscape_paper(self):
        wide = os.path.join(self.folder, "wide.png")
        Image.new("RGBA", (3000, 1000), (0, 128, 0, 128)).save(wide, dpi=(150, 150))
        pdf = self.convert(wide, page_size="a4")["files"][0]["pdf"]
        with pymupdf.open(pdf) as doc:
            self.assertEqual((round(doc[0].rect.width), round(doc[0].rect.height)), (842, 595))
            image_box = doc[0].get_image_rects(doc[0].get_images()[0][0])[0]
            self.assertTrue(doc[0].rect.contains(image_box))

    def test_multi_page_tiff_becomes_several_pages(self):
        scan = os.path.join(self.folder, "scan.tif")
        frames = [Image.new("L", (300, 400), shade) for shade in (0, 128, 255)]
        frames[0].save(scan, save_all=True, append_images=frames[1:])
        pdf = self.convert(scan)["files"][0]["pdf"]
        self.assertEqual(len(page_texts(pdf)), 3)

    def test_markdown_with_a_table_and_indian_scripts(self):
        notes = os.path.join(self.folder, "notes.md")
        with open(notes, "w", encoding="utf-8") as handle:
            handle.write("# Lab notes\n\nপৰীক্ষাগাৰ — प्रयोगशाला\n\n| Sample | Lead |\n|---|---|\n| S-1 | 0.12 |\n")
        pdf = self.convert(notes)["files"][0]["pdf"]
        text = page_texts(pdf)[0]
        self.assertIn("Lab notes", text)
        self.assertIn("S-1", text)
        with pymupdf.open(pdf) as doc:
            fonts = " ".join(f[3] for f in doc[0].get_fonts())
        self.assertIn("Bengali", fonts)
        self.assertIn("Devanagari", fonts)

    def test_text_html_and_csv(self):
        paths = []
        for name, content in (("a.txt", "Line one\nLine two"), ("b.html", "<h1>Hello</h1><p>World</p>"), ("c.csv", "x,y\n1,2")):
            path = os.path.join(self.folder, name)
            with open(path, "w", encoding="utf-8") as handle:
                handle.write(content)
            paths.append(path)
        files = self.convert(*paths)["files"]
        self.assertEqual(len(files), 3)
        self.assertIn("Line two", page_texts(files[0]["pdf"])[0])
        self.assertIn("World", page_texts(files[1]["pdf"])[0])
        self.assertIn("2", page_texts(files[2]["pdf"])[0])

    def test_unsupported_and_missing_files_fail_one_by_one(self):
        good = os.path.join(self.folder, "ok.txt")
        with open(good, "w") as handle:
            handle.write("fine")
        answer = self.convert(os.path.join(self.folder, "song.mp3"), good, os.path.join(self.folder, "gone.png"))
        self.assertEqual(len(answer["files"]), 1)
        self.assertEqual(len(answer["failed"]), 2)

    @unittest.skipUnless(HAS_OFFICE, "LibreOffice is not installed")
    def test_word_and_excel_through_the_office_suite(self):
        import docx
        import openpyxl

        word = os.path.join(self.folder, "Report.docx")
        document = docx.Document()
        document.add_heading("Method validation", 1)
        document.add_paragraph("Moisture 4.2 % w/w")
        document.save(word)
        sheet_path = os.path.join(self.folder, "Results.xlsx")
        book = openpyxl.Workbook()
        book.active.append(["Sample", "Lead"])
        book.active.append(["S-1", 0.12])
        book.save(sheet_path)
        files = self.convert(word, sheet_path, profile_dir=os.path.join(self.folder, "profile"))["files"]
        self.assertEqual(len(files), 2)
        self.assertIn("Moisture", page_texts(files[0]["pdf"])[0])
        self.assertIn("S-1", page_texts(files[1]["pdf"])[0])


class ExportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.folder = tempfile.mkdtemp(prefix="aw-export-")
        cls.pdf = os.path.join(cls.folder, "Report.pdf")
        with pymupdf.open() as doc:
            for n in (1, 2):
                page = doc.new_page()
                page.insert_text((72, 80), f"Test Report {n}", fontsize=22)
                page.insert_text((72, 120), "Results of chemical analysis.", fontsize=11)
                # A 3×3 ruled table
                x, y, w, h = 72, 160, 150, 22
                rows = [["Parameter", "Result", "Unit"], ["Lead", "0.12", "mg/kg"], ["Code", "007", "-"]]
                for r, row in enumerate(rows):
                    for c, value in enumerate(row):
                        cell = pymupdf.Rect(x + c * w, y + r * h, x + (c + 1) * w, y + (r + 1) * h)
                        page.draw_rect(cell, color=(0, 0, 0), width=0.7)
                        page.insert_text((cell.x0 + 4, cell.y1 - 7), value, fontsize=10)
            doc.save(cls.pdf)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.folder)

    def export(self, fmt, pages=None, **extra):
        request = {"command": "export", "format": fmt, "sources": [{"path": self.pdf}],
                   "pages": pages or [{"src": 0, "page": 1}, {"src": 0, "page": 2}], "base_name": "Report", **extra}
        (answer,) = ask(request)
        return answer

    def out(self, name):
        return os.path.join(self.folder, name)

    def test_word(self):
        answer = self.export("docx", output=self.out("Report.docx"))
        self.assertEqual(answer["type"], "exported", answer)
        import docx
        text = "\n".join(p.text for p in docx.Document(self.out("Report.docx")).paragraphs)
        tables = docx.Document(self.out("Report.docx")).tables
        self.assertIn("Test Report 1", text)
        self.assertTrue(tables or "Lead" in text)

    def test_excel_tables_with_numbers_and_codes(self):
        answer = self.export("xlsx", output=self.out("Report.xlsx"))
        self.assertEqual(answer["warnings"], [])
        import openpyxl
        book = openpyxl.load_workbook(self.out("Report.xlsx"))
        self.assertEqual(book.sheetnames, ["Page 1", "Page 2"])
        values = [[c.value for c in row] for row in book["Page 1"].iter_rows()]
        self.assertEqual(values[0], ["Parameter", "Result", "Unit"])
        self.assertEqual(values[1][1], 0.12)  # a number Excel can calculate with
        self.assertEqual(values[2][1], "007")  # a code keeps its leading zeros

    def test_powerpoint_text_is_editable_and_follows_rotation(self):
        answer = self.export("pptx", output=self.out("Report.pptx"),
                             pages=[{"src": 0, "page": 1}, {"src": 0, "page": 2, "rotate": 90}])
        self.assertEqual(answer["type"], "exported", answer)
        from pptx import Presentation
        deck = Presentation(self.out("Report.pptx"))
        self.assertEqual(len(deck.slides), 2)
        texts = [shape for shape in deck.slides[0].shapes if shape.has_text_frame and shape.text_frame.text]
        self.assertTrue(any("Test Report 1" in s.text_frame.text for s in texts))
        turned = [s for s in deck.slides[1].shapes if s.has_text_frame and "Test Report 2" in s.text_frame.text]
        self.assertEqual(turned[0].rotation, 90.0)

    def test_png_one_file_per_page(self):
        folder = self.out("pngs")
        os.mkdir(folder)
        answer = self.export("png", folder=folder, dpi=72)
        self.assertEqual([os.path.basename(f["path"]) for f in answer["files"]], ["Report - page 1.png", "Report - page 2.png"])
        with Image.open(answer["files"][0]["path"]) as image:
            self.assertEqual(image.size, (595, 842))

    def test_single_page_jpeg_goes_to_the_chosen_name(self):
        answer = self.export("jpeg", output=self.out("one.jpg"), pages=[{"src": 0, "page": 2}], dpi=100)
        self.assertEqual(answer["files"][0]["path"], self.out("one.jpg"))

    def test_multi_page_tiff(self):
        self.export("tiff", output=self.out("Report.tiff"), dpi=72)
        with Image.open(self.out("Report.tiff")) as image:
            self.assertEqual(image.n_frames, 2)

    def test_text_html_markdown(self):
        self.export("txt", output=self.out("Report.txt"))
        self.export("html", output=self.out("Report.html"))
        self.export("md", output=self.out("Report.md"))
        with open(self.out("Report.txt"), encoding="utf-8") as handle:
            self.assertIn("Results of chemical analysis.", handle.read())
        with open(self.out("Report.html"), encoding="utf-8") as handle:
            page = handle.read()
            self.assertIn('<meta charset="utf-8">', page)
            self.assertIn("Test Report 2", page)
        with open(self.out("Report.md"), encoding="utf-8") as handle:
            markdown = handle.read()
            self.assertIn("# Test Report 1", markdown)
            self.assertIn("|Lead|0.12|mg/kg|".replace("|", ""), markdown.replace("|", "").replace(" ", ""))

    def test_scanned_pages_get_a_warning(self):
        scan = os.path.join(self.folder, "scan.pdf")
        with pymupdf.open() as doc:
            pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 200, 200), False)
            pix.clear_with(180)
            doc.new_page().insert_image(pymupdf.Rect(50, 50, 250, 250), pixmap=pix)
            doc.save(scan)
        (answer,) = ask({"command": "export", "format": "txt", "sources": [{"path": scan}],
                         "pages": [{"src": 0, "page": 1}], "output": self.out("scan.txt")})
        self.assertIn("OCR", answer["warnings"][0])

    def test_unknown_format_is_refused(self):
        self.assertEqual(self.export("exe", output=self.out("x.exe"))["type"], "error")


if __name__ == "__main__":
    unittest.main()
