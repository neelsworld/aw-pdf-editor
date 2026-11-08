# SPDX-License-Identifier: AGPL-3.0-or-later
"""Run: worker/.venv/bin/python -m unittest discover -s worker/tests  (from desktop/)."""

import json
import os
import subprocess
import sys
import tempfile
import unittest

import pymupdf

SRC = os.path.join(os.path.dirname(__file__), "..", "src")


def ask(request):
    """Start the worker the way the app does: one request line in, answer lines out."""
    env = dict(os.environ, PYTHONPATH=SRC)
    run = subprocess.run(
        [sys.executable, "-X", "utf8", "-m", "aw_pdf_worker"],
        input=json.dumps(request) + "\n", capture_output=True, text=True, encoding="utf-8", env=env, timeout=60,
    )
    return [json.loads(line) for line in run.stdout.splitlines() if line.strip()]


class WorkerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.folder = tempfile.mkdtemp(prefix="aw-pdf-worker-")
        # An Assamese file name, to prove non-Latin paths survive the pipes.
        cls.pdf = os.path.join(cls.folder, "পৰীক্ষা report.pdf")
        with pymupdf.open() as doc:
            for _ in range(3):
                doc.new_page(width=595, height=842)  # A4
            doc.set_metadata({"title": "Test report", "author": "AW"})
            doc.save(cls.pdf)

    def test_ping_names_the_engine(self):
        (answer,) = ask({"command": "ping"})
        self.assertEqual(answer["type"], "pong")
        self.assertIn("MuPDF", answer["engine"])

    def test_info_describes_the_pdf(self):
        (answer,) = ask({"command": "info", "path": self.pdf})
        self.assertEqual(answer["type"], "info", answer)
        self.assertEqual(answer["pages"], 3)
        self.assertEqual(answer["title"], "Test report")
        self.assertEqual(answer["first_page_size"], [595.0, 842.0])

    def test_missing_file_is_a_plain_error(self):
        (answer,) = ask({"command": "info", "path": os.path.join(self.folder, "nope.pdf")})
        self.assertEqual(answer["type"], "error")
        self.assertIn("could not be found", answer["error"])

    def test_not_a_pdf_is_a_plain_error(self):
        text = os.path.join(self.folder, "notes.pdf")
        with open(text, "w") as handle:
            handle.write("hello")
        (answer,) = ask({"command": "info", "path": text})
        self.assertEqual(answer["type"], "error")

    def test_unknown_command(self):
        (answer,) = ask({"command": "explode"})
        self.assertEqual(answer["type"], "error")


if __name__ == "__main__":
    unittest.main()
