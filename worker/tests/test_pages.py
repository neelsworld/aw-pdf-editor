# SPDX-License-Identifier: AGPL-3.0-or-later
"""Phase 1 page operations, checked by reading the saved files back with PyMuPDF.
Run: worker/.venv/bin/python -m unittest discover -s worker/tests  (from desktop/)."""

import os
import shutil
import tempfile
import unittest

import pymupdf

from test_worker import ask


def make_pdf(path, pages, label, size=(595, 842), toc=None, **save_args):
    with pymupdf.open() as doc:
        for n in range(1, pages + 1):
            page = doc.new_page(width=size[0], height=size[1])
            page.insert_text((72, 100), f"{label} page {n}", fontsize=14)
        if toc:
            doc.set_toc(toc)
        doc.save(path, **save_args)
    return path


def texts(path, password=None):
    with pymupdf.open(path) as doc:
        if password:
            doc.authenticate(password)
        return [page.get_text().strip() for page in doc]


class PlanTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.mkdtemp(prefix="aw-pages-")
        self.a = make_pdf(os.path.join(self.folder, "A.pdf"), 4, "A",
                          toc=[[1, "Intro", 1], [1, "Results", 3], [2, "Table 1", 4]])
        self.b = make_pdf(os.path.join(self.folder, "B.pdf"), 2, "B")
        self.out = os.path.join(self.folder, "out.pdf")

    def tearDown(self):
        shutil.rmtree(self.folder)

    def save(self, pages, sources=None, **extra):
        request = {"command": "apply_plan", "sources": sources or [{"path": self.a}], "pages": pages,
                   "output": self.out, "overwrite": True, **extra}
        (answer,) = ask(request)
        return answer

    def test_reorder_delete_duplicate(self):
        answer = self.save([{"src": 0, "page": 3}, {"src": 0, "page": 1}, {"src": 0, "page": 1}])
        self.assertEqual(answer["type"], "saved", answer)
        self.assertEqual(texts(self.out), ["A page 3", "A page 1", "A page 1"])

    def test_rotate_adds_to_existing_rotation(self):
        self.save([{"src": 0, "page": 1, "rotate": 90}, {"src": 0, "page": 2, "rotate": 270}])
        with pymupdf.open(self.out) as doc:
            self.assertEqual([p.rotation for p in doc], [90, 270])
        # Turn the saved file again: 90 + 90 = 180.
        shutil.copy(self.out, self.a)
        self.save([{"src": 0, "page": 1, "rotate": 90}])
        with pymupdf.open(self.out) as doc:
            self.assertEqual(doc[0].rotation, 180)

    def test_blank_page_and_merge(self):
        answer = self.save([{"src": 0, "page": 1}, {"blank": [595, 842]}, {"src": 1, "page": 2}],
                           sources=[{"path": self.a}, {"path": self.b}])
        self.assertEqual(answer["pages"], 3)
        self.assertEqual(texts(self.out), ["A page 1", "", "B page 2"])

    def test_merge_adds_a_bookmark_per_file_and_keeps_inner_ones(self):
        pages = [{"src": 0, "page": n} for n in range(1, 5)] + [{"src": 1, "page": n} for n in (1, 2)]
        self.save(pages, sources=[{"path": self.a}, {"path": self.b}])
        with pymupdf.open(self.out) as doc:
            self.assertEqual(doc.get_toc(), [[1, "A", 1], [2, "Intro", 1], [2, "Results", 3], [3, "Table 1", 4], [1, "B", 5]])

    def test_merge_bookmark_uses_the_original_file_title(self):
        self.save([{"src": 0, "page": 1}, {"src": 1, "page": 1}],
                  sources=[{"path": self.a}, {"path": self.b, "title": "Field photo"}])
        with pymupdf.open(self.out) as doc:
            self.assertEqual([title for level, title, _ in doc.get_toc() if level == 1], ["A", "Field photo"])

    def test_bookmarks_follow_moved_pages_and_vanish_with_deleted_ones(self):
        self.save([{"src": 0, "page": 4}, {"src": 0, "page": 1}])  # page 3 ("Results") deleted
        with pymupdf.open(self.out) as doc:
            # "Results" is gone; "Table 1" (old page 4, now page 1) stays, nested under the bookmark before it.
            self.assertEqual(doc.get_toc(), [[1, "Intro", 2], [2, "Table 1", 1]])

    def test_crop_is_measured_as_seen_on_screen(self):
        # Rotated 90°: the visible page is 842 wide and 595 high. Cropping 50 off the visible top
        # must make it 50 points less high, whatever edge that is on the unrotated page.
        self.save([{"src": 0, "page": 1, "rotate": 90, "crop": [50, 0, 0, 0]},
                   {"src": 0, "page": 2, "crop": [10, 20, 30, 40]}])
        with pymupdf.open(self.out) as doc:
            self.assertEqual((round(doc[0].rect.width), round(doc[0].rect.height)), (842, 545))
            self.assertEqual((round(doc[1].rect.width), round(doc[1].rect.height)), (595 - 60, 842 - 40))

    def test_crop_larger_than_page_is_refused(self):
        answer = self.save([{"src": 0, "page": 1, "crop": [500, 0, 500, 0]}])
        self.assertEqual(answer["type"], "error")
        self.assertIn("larger than the page", answer["error"])

    def test_password_protection_round_trip(self):
        self.save([{"src": 0, "page": 1}], protect={"mode": "password", "open_password": "lab123"})
        with pymupdf.open(self.out) as doc:
            self.assertTrue(doc.needs_pass)
            self.assertTrue(doc.authenticate("lab123"))
        # Open the protected file with its password, then save it without protection.
        protected = os.path.join(self.folder, "protected.pdf")
        shutil.move(self.out, protected)
        (info,) = ask({"command": "info", "path": protected})
        self.assertTrue(info["needs_password"])
        (wrong,) = ask({"command": "info", "path": protected, "password": "nope"})
        self.assertEqual(wrong["type"], "error")
        (right,) = ask({"command": "info", "path": protected, "password": "lab123"})
        self.assertEqual(right["pages"], 1)
        self.save([{"src": 0, "page": 1}], sources=[{"path": protected, "password": "lab123"}], protect={"mode": "none"})
        with pymupdf.open(self.out) as doc:
            self.assertFalse(doc.needs_pass)

    def test_restrictions_need_a_permissions_password(self):
        answer = self.save([{"src": 0, "page": 1}], protect={"mode": "password", "allow_copy": False})
        self.assertEqual(answer["type"], "error")
        self.save([{"src": 0, "page": 1}], protect={"mode": "password", "allow_copy": False, "permissions_password": "owner"})
        with pymupdf.open(self.out) as doc:
            self.assertFalse(doc.needs_pass)  # opens without a password…
            self.assertFalse(doc.permissions & pymupdf.PDF_PERM_COPY)  # …but copying is not allowed

    def test_save_over_the_open_file_is_atomic(self):
        answer = self.save([{"src": 0, "page": 2}, {"src": 0, "page": 1}], output=self.a)
        self.assertEqual(answer["type"], "saved", answer)
        self.assertEqual(texts(self.a), ["A page 2", "A page 1"])
        leftovers = [n for n in os.listdir(self.folder) if n.endswith(".tmp")]
        self.assertEqual(leftovers, [])

    def test_existing_file_is_not_replaced_without_permission(self):
        answer = self.save([{"src": 0, "page": 1}], output=self.b, overwrite=False)
        self.assertEqual(answer["type"], "error")
        self.assertEqual(texts(self.b), ["B page 1", "B page 2"])

    def test_bad_plans_are_plain_errors(self):
        for pages in ([], [{"src": 5, "page": 1}], [{"src": 0, "page": 99}], [{"src": 0, "page": 1, "rotate": 45}]):
            self.assertEqual(self.save(pages)["type"], "error", pages)

    def test_shared_resources_are_copied_once(self):
        # Ten copies of one page must not be ten times the size of one.
        image = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 400, 400), False)
        image.clear_with(200)
        with_image = os.path.join(self.folder, "img.pdf")
        with pymupdf.open() as doc:
            doc.new_page().insert_image(pymupdf.Rect(50, 50, 450, 450), pixmap=image)
            doc.save(with_image)
        self.save([{"src": 0, "page": 1}], sources=[{"path": with_image}])
        one = os.path.getsize(self.out)
        self.save([{"src": 0, "page": 1}] * 10, sources=[{"path": with_image}])
        self.assertLess(os.path.getsize(self.out), one * 3)


class SplitTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.mkdtemp(prefix="aw-split-")
        self.src = make_pdf(os.path.join(self.folder, "Report.pdf"), 7, "R",
                            toc=[[1, "Chemical", 1], [1, "Micro/Bio", 4], [2, "Detail", 5], [1, "Annex", 6]])
        self.parts = os.path.join(self.folder, "parts")
        os.mkdir(self.parts)

    def tearDown(self):
        shutil.rmtree(self.folder)

    def split(self, mode, pages=None):
        (answer,) = ask({"command": "split", "sources": [{"path": self.src}],
                         "pages": pages or [{"src": 0, "page": n} for n in range(1, 8)],
                         "folder": self.parts, "base_name": "Report", "mode": mode})
        return answer

    def test_ranges(self):
        answer = self.split({"kind": "ranges", "ranges": [[1, 2], [3, 7]]})
        self.assertEqual([(f["first_page"], f["last_page"]) for f in answer["files"]], [(1, 2), (3, 7)])
        self.assertEqual(texts(answer["files"][1]["path"])[0], "R page 3")

    def test_every_n_pages(self):
        answer = self.split({"kind": "every", "pages": 3})
        self.assertEqual([os.path.basename(f["path"]) for f in answer["files"]],
                         ["Report (part 1).pdf", "Report (part 2).pdf", "Report (part 3).pdf"])
        self.assertEqual(len(texts(answer["files"][2]["path"])), 1)

    def test_bookmarks_name_the_parts(self):
        answer = self.split({"kind": "bookmarks"})
        self.assertEqual([os.path.basename(f["path"]) for f in answer["files"]],
                         ["Report - Chemical.pdf", "Report - Micro Bio.pdf", "Report - Annex.pdf"])
        self.assertEqual([(f["first_page"], f["last_page"]) for f in answer["files"]], [(1, 3), (4, 5), (6, 7)])

    def test_size_limit(self):
        # Seven pages, each with ~120 KB of incompressible image, split at 300 KB per part.
        with pymupdf.open() as doc:
            for _ in range(7):
                noise = pymupdf.Pixmap(pymupdf.csRGB, 200, 200, os.urandom(200 * 200 * 3), False)
                doc.new_page().insert_image(pymupdf.Rect(50, 50, 450, 450), pixmap=noise)
            doc.save(self.src)
        answer = self.split({"kind": "size", "max_bytes": 300_000})
        self.assertEqual(answer["type"], "split_done", answer)
        self.assertGreater(len(answer["files"]), 2)
        self.assertTrue(all(f["size_bytes"] <= 300_000 for f in answer["files"]))
        pages = sum(f["last_page"] - f["first_page"] + 1 for f in answer["files"])
        self.assertEqual(pages, 7)

    def test_existing_parts_are_never_replaced(self):
        first = self.split({"kind": "every", "pages": 7})
        second = self.split({"kind": "every", "pages": 7})
        self.assertNotEqual(first["files"][0]["path"], second["files"][0]["path"])
        self.assertTrue(second["files"][0]["path"].endswith("Report (part 1) (2).pdf"))

    def test_split_uses_the_arranged_pages(self):
        answer = self.split({"kind": "every", "pages": 1}, pages=[{"src": 0, "page": 7}, {"src": 0, "page": 1}])
        self.assertEqual(texts(answer["files"][0]["path"]), ["R page 7"])

    def test_bad_range_is_a_plain_error(self):
        answer = self.split({"kind": "ranges", "ranges": [[5, 9]]})
        self.assertEqual(answer["type"], "error")
        self.assertIn("outside", answer["error"])


if __name__ == "__main__":
    unittest.main()
