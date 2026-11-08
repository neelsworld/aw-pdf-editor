# SPDX-License-Identifier: AGPL-3.0-or-later
"""PyInstaller entry point: starts the worker package with a normal (absolute) import."""
import sys

from aw_pdf_worker.__main__ import main

sys.exit(main())
