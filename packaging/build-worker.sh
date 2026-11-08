#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Packs the Python worker into a standalone folder with PyInstaller (onedir: faster start than onefile,
# and the bundled libraries stay as separate, replaceable files). Output: worker/dist/aw-pdf-worker/
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/worker"
PY="${AW_PDF_PYTHON:-.venv/bin/python}"
"$PY" -m PyInstaller --noconfirm --clean --onedir --name aw-pdf-worker \
  --paths src --collect-binaries pymupdf --collect-data pymupdf \
  --add-data "$ROOT/worker/tessdata:tessdata" \
  --exclude-module tkinter --exclude-module unittest --exclude-module pydoc \
  --distpath dist --workpath build/pyinstaller --specpath build \
  entrypoint.py
echo "Worker packed: $ROOT/worker/dist/aw-pdf-worker"
