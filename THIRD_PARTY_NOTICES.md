# Third-party software

AW PDF Editor includes the following open-source software. Each keeps its own licence; their licence
texts ship with the app. Re-check this list at every release.

| Component | Used for | Licence |
|---|---|---|
| PyMuPDF / MuPDF (Artifex Software), including MuPDF's built-in Tesseract OCR and Leptonica | PDF engine and OCR in the worker | GNU AGPL-3.0 (MuPDF); Tesseract Apache-2.0; Leptonica BSD-2-Clause (re-check at release) |
| tessdata_fast language data (eng, asm, ben, hin) | OCR | Apache-2.0 (`worker/tessdata/README.md`) |
| pdf.js (Mozilla) — pdfjs-dist 4.10.38 from https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-4.10.38.tgz (Apache-2.0). Files copied unchanged from build/. | On-screen PDF viewer | Apache-2.0 (`app/ui/vendor/pdfjs/LICENSE`) |
| Tauri (Tauri Programme) and its Rust dependencies, incl. the base64 crate | App window and system access | MIT or Apache-2.0 |
| Python (Python Software Foundation) | Runs the worker | PSF License |
| PyInstaller bootloader | Packs the worker | GPL-2.0 with bootloader exception |
| Pillow | Images in and out | MIT-CMU |
| Markdown (Python-Markdown) | Markdown to PDF | BSD-3-Clause |
| pdf2docx | PDF to Word | MIT |
| python-docx, fonttools, termcolor | Used by pdf2docx | MIT |
| NumPy | Used by pdf2docx | BSD-3-Clause and others (see its licence file) |
| OpenCV (opencv-python-headless), incl. its bundled libraries (FFmpeg and others) | Used by pdf2docx | Apache-2.0; bundled libraries under their own licences (LGPL/BSD/MIT and others), listed in OpenCV's licence files. Re-check at release |
| Python Fire | Used by pdf2docx | Apache-2.0 |
| openpyxl, et-xmlfile | PDF to Excel | MIT |
| python-pptx | PDF to PowerPoint | MIT |
| lxml | Used by python-docx / python-pptx | BSD-3-Clause |
| XlsxWriter | Used by python-pptx | BSD-2-Clause |
| typing-extensions | Used by python-pptx | PSF |
| Interface styles and icons from AW Signer | Shared AccredWorks look | Contributed by AccredWorks under AGPL-3.0-or-later |

Not bundled, used when installed: LibreOffice (MPL-2.0) and Microsoft Office, for converting Office files.

Possibly added later (not shipped): Ghostscript (AGPL-3.0) for PDF/A; Noto fonts (SIL OFL 1.1).
