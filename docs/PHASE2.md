# Phase 2 report: Convert and export (2026-11-02)

## What it does

**Create PDF** (Home → Create PDF; Insert/Replace in Organise; dropping files on the window)

| From | How |
|---|---|
| JPG, PNG, TIFF (multi-page), BMP, GIF, WebP | Built in. Photos are turned upright from their EXIF orientation; JPEGs that need no turning go in unchanged (no quality loss). Page size: same as the image, or fitted on A4 / Letter (landscape pictures get landscape paper; never enlarged) |
| Word, Excel, PowerPoint, OpenDocument, RTF | The office suite on the computer: Microsoft Office on Windows (Word/Excel/PowerPoint's own "Export as PDF"), otherwise LibreOffice, run in the background with its own profile. If neither is installed, the app says so and links to LibreOffice's download page |
| Text, CSV, HTML, Markdown | Built in (PyMuPDF layout; Markdown tables supported). Assamese, Bengali and Hindi render correctly with MuPDF's built-in Noto fonts |
| Several mixed files | Converted, then combined into one new document in the Organise view (sorted by name), where they can be reordered before saving. On saving, each file gets a bookmark named after the original file |

**Export PDF** (Home → Export PDF, or Export… in the document toolbar). It includes unsaved changes, and can export all pages, the selected pages or the current page.

| To | How |
|---|---|
| Word (.docx) | pdf2docx. Text, tables and images. Labelled beta |
| Excel (.xlsx) | Each table PyMuPDF finds becomes a sheet. Numbers stay numbers, but codes like "007" keep their zeros. With no tables, the text goes into one column, with a notice |
| PowerPoint (.pptx) | One slide per page. The page's pictures and drawings form the background, and the text sits on top as editable text boxes, placed and turned to match rotated pages |
| PNG / JPEG | One file per page into a folder, or the chosen file for a single page. 72–600 dpi |
| TIFF | One multi-page file (LZW) |
| Text, HTML, Markdown | Text in reading order. HTML is one self-contained file. Markdown has headings by text size, plus tables |

If the pages have no selectable text (scans), the app warns that the export will be poor and suggests OCR first (OCR comes in Phase 4).

## Tests

- Worker: 42 tests in all (16 new, plus one for bookmark titles of converted files). Every create/export test reads the result back with python-docx,
  openpyxl, python-pptx, Pillow or PyMuPDF. They cover: EXIF rotation, A4 fitting, multi-page TIFF,
  Markdown with tables and Indian scripts, text/HTML/CSV, per-file failures, Word and Excel through
  LibreOffice (real conversion on this Mac), Word, Excel with numbers and codes, PowerPoint text
  rotation, PNG/JPEG/TIFF, text/HTML/Markdown, the scan warning, and refusing an unknown format.
- Rust: 6 tests, including that conversion and export can only read what you chose and only write
  where you chose, and that the page can't pick the worker's working folder.
- End to end in the browser pane with the real worker: Create PDF from a PDF, a photo, a Word file,
  an Excel file and a Markdown note produced 7 pages in name order. That unsaved document then exported
  to all nine formats; each file was opened and checked. The PowerPoint was rendered through LibreOffice
  to check placement (that found and fixed text boxes wrapping too early).
- The packed worker (PyInstaller) exports Word, Excel and PowerPoint correctly.
- The Windows shell cross-compiles.

## Known limitations

- **Assamese/Bengali/Hindi typed text turned into PDF** (from .txt/.md/.html) *looks* right, but the PDF's
  hidden text layer comes out garbled, so copying or searching it gives nonsense. This is a MuPDF
  limitation with these scripts when it creates text. Real PDFs from Word or LibreOffice are not
  affected. A possible fix is to OCR such pages in Phase 4.
- **Microsoft Office conversion on Windows is written but not yet run on a Windows PC.**
- LibreOffice's first conversion takes about 10–15 s while it prepares its profile; later ones are faster.
- PowerPoint text boxes use PowerPoint's default font when the PDF's font isn't installed.

## Size: decided 2026-11-02, keep pdf2docx (~92 MB download)

pdf2docx needs OpenCV, and OpenCV brings ~78 MB of video libraries (FFmpeg, AV1, SDL, OpenEXR) that
Word export never uses but can't be removed. Measured on Apple Silicon:

| | Packed worker on disk | Download (compressed) |
|---|---|---|
| Phase 0 (PyMuPDF only) | 71 MB | ~36 MB with the shell |
| Phase 2 (all converters) | 218 MB, of which OpenCV is 118 MB | **~92 MB** with the shell |

Neel chose option 1 on 2026-11-02. The options were:
1. **Keep as is (chosen).** ~92 MB is still small next to Acrobat, and Word export is the
   most-asked conversion. Simplest and most faithful.
2. **Write our own Word writer** (python-docx + PyMuPDF: text, tables, images) and drop pdf2docx/OpenCV:
   download back to ~40 MB, but weaker layout for complex documents. About a phase of work.
3. **Optional "Word export" download** inside the app the first time it's used. Smaller installer, but a
   one-time internet download, which goes against "fully offline".

## Not yet checked

- In the real Mac window: native dialogs with real files and drag-and-drop of Word files and photos. The
  dev app is rebuilt with Phase 2 for trying by hand.
- Windows: the whole app, including Microsoft Office conversion.
