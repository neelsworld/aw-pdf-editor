# AW PDF Editor

A free, offline PDF editor for Mac and Windows, made by [AccredWorks](https://accredworks.com). Your files
never leave your computer: no account, no uploads, no usage limits. When a document needs a digital
signature with a DSC USB token, it hands the file to [AW Signer](https://accredworks.com).

**Download:** [accredworks.com/pdf-editor](https://accredworks.com/pdf-editor) (Mac DMG, Windows installer)
or the [Microsoft Store](https://apps.microsoft.com/detail/9MW1KVP16BPF).

It opens, reads and organises PDFs (reorder, rotate, delete, insert, crop, merge, split, extract,
password-protect, with undo); creates PDFs from images, Office and text files; exports to Word, Excel,
PowerPoint, images, text, HTML and Markdown; marks up (highlights, notes, text, drawings, stamps,
pictures), fills forms, adds watermarks and page numbers; redacts for good, edits text (beta), makes
scans searchable with OCR (English, Assamese, Bengali, Hindi), reduces file size and batch-processes.

Current version: **0.1.1**.

## Who makes it

AW PDF Editor is built by Neel Kalita, a lab quality professional in Assam, India.

- [accredworks.com](https://accredworks.com): AW PDF Editor and AW Signer, tools for labs and offices
- [neelsworld.in](https://neelsworld.in): AI tools explained for everyday readers
- [YouTube: @neelsworld](https://www.youtube.com/@neelsworld): videos on AI tools and how to use them

Questions and bug reports: open an issue here, or write to support@accredworks.com.

## How it's built

```
app/src-tauri   Rust (Tauri 2): window, file pickers, starts the worker, hands PDF bytes to the viewer
app/ui          Plain HTML/CSS/JS (app.js; markup.js for the Mark up view), no framework. style.css is AW Signer's, unchanged; icons.js is AW
                Signer's set plus the editor's own icons at the end; editor.css adds the editor parts
worker          Python + PyMuPDF (MuPDF): all PDF reading and writing. One JSON request per run
packaging       Build scripts
brand           AW logo and icons, all rights reserved, NOT under the AGPL (see TRADEMARKS.md)
```

## Run it (development)

```sh
cd worker && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt && cd ..
cd app/src-tauri && cargo run
```

Pass a PDF path to open it straight away: `cargo run -- /path/to/file.pdf`.

## Tests

```sh
worker/.venv/bin/python -m unittest discover -s worker/tests
cd app/src-tauri && cargo test
```

## Pack the worker

```sh
worker/.venv/bin/pip install pyinstaller
packaging/build-worker.sh        # → worker/dist/aw-pdf-worker/
```

## Licence

GNU Affero General Public License, version 3 or (at your option) any later version. See `LICENSE`.
Third-party components: `THIRD_PARTY_NOTICES.md`. Names and logo: `TRADEMARKS.md`.

This program comes with no warranty.
