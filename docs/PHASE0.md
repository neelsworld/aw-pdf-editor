# Phase 0 report (2026-11-02)

## Done

- Repo layout: `LICENSE` (AGPL-3.0 text from the SPDX licence list), `README.md`, `TRADEMARKS.md`,
  `THIRD_PARTY_NOTICES.md`, `brand/` (AW mark and icons, all rights reserved, with `NOTICE.md`),
  neutral placeholder icons in `app/`, `packaging/apply-brand.sh` for official builds (refuses to run on
  the working tree).
- Worker (`worker/`): Python + PyMuPDF 1.28.2. Commands `ping` and `info`. Same protocol as AW Signer:
  one JSON request on stdin, JSON answer on stdout, then exit. 5 unit tests pass (including an
  Assamese file name).
- Shell (`app/src-tauri`): Tauri 2, built with plain `cargo` (no npm, no Tauri CLI), like AW Signer
  for Windows. Opens PDFs by picker, drag-and-drop or launch argument; the viewer may read only files
  the person opened; links limited to accredworks.com; recent files kept by the shell. 3 Rust tests pass
  (including a real worker round trip).
- UI (`app/ui`): AW Signer's `style.css` and `icons.js` copied unchanged, so the look matches. The
  sidebar has Home, Document, Settings, Help & about, and a "Sign with DSC" footer. The Document view
  has a toolbar (yellow "Sign with DSC" button), thumbnails, continuous pages, zoom, fit to width and a
  status bar. Light/dark and the AccredWorks/Blue themes work the same way as in AW Signer.

## Checked

- The Mac debug app opened a 5-page sample report.
- The UI was checked in light and dark mode in the browser pane, with real worker answers (Home,
  Document, the Sign with DSC panel).
- The Windows x64 shell cross-compiles (`cargo xwin build --release --target x86_64-pc-windows-msvc`).

## Not yet checked

- The Windows build has **not been run on Windows**, and the Windows worker isn't packed yet (it will
  follow AW Signer's `windows/packaging` route).
- No signed or notarised Mac `.app`/DMG yet (Phase 5).
- Finder "Open with" on Mac needs the bundled app (Phase 5).

## Sizes (measured on Apple Silicon)

| Part | On disk | Compressed (gzip) |
|---|---|---|
| Shell, release build | 6.0 MB (symbols not stripped: `rust-objcopy` aborted; strip at packaging) | 2.4 MB |
| Packed worker (PyInstaller onedir, Python 3.14 + PyMuPDF 1.28.2) | 71 MB | 33 MB |
| **Mac download estimate today** | | **≈ 36 MB** |
| Windows shell (`.exe`) | 5.4 MB | — |

The packed worker starts and answers `ping` in about 0.2 s.

Later phases add: Tesseract + 4 languages (OCR), Noto fonts, pdf2docx with OpenCV (≈ 64 MB of
downloads), openpyxl, python-pptx, and Ghostscript in v1.x. Re-measure at the end of each phase.

## Decision made during Phase 0

**PyMuPDF 1.28.2, not 2.0.** PyMuPDF 2.0 (2026-10-19) imports onnxruntime, numpy and a ~50 MB layout
model on every start (about +130 MB on disk, slower start), and PyPI had no Intel Mac wheel for it.
1.28.2 (2026-08-06) has no dependencies and wheels for Intel Mac, Apple Silicon and Windows x64, under
the same AGPL licence. Revisit when PyMuPDF makes the layout part optional.
