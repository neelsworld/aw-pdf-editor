# Microsoft Store listing: submitted 2026-11-08 (in certification)

## Status (2026-11-07)

- Version bumped to **0.1.1** (Neel's choice) so the Store build has the Sign with DSC hand-off (incl. AW Signer
  Store alias) and the R1 reader features. Files: Cargo.toml, tauri.conf.json, worker pyproject + __init__
  (backup `_backups/2026-11-07-version-0.1.1/`). The website still serves 0.1.0 (Mac + Windows).
- Built: `dist/AW-PDF-Editor-0.1.1-windows-x64.msix` (0.1.1.0, 113 MB), sha256 `1ec8f52f…3750a`; also
  `dist/AW-PDF-Editor-0.1.1-windows-x64-setup.exe` (sha256 `1163a574…74d9`, not uploaded anywhere).
- Partner Center submission 1 filled by Claude: Pricing (free), Properties (Productivity / Utilities + tools,
  privacy https://accredworks.com/privacy, website accredworks.com/pdf-editor, support@accredworks.com),
  English (US) listing (description with "Source code: on request", short description, 13 features,
  7 keywords, 2 screenshots, copyright, developer), Submission options (hold until "Publish now"), and
  notes for certification. Neel did Age ratings (IARC) and uploaded the 0.1.1 .msix (validated); Claude added the
  runFullTrust justification and **submitted for certification on 2026-11-08** (publishing held for "Publish now").

## Status (2026-11-05, night)

- Name **AW PDF Editor** reserved by Neel. Store ID `9MW1KVP16BPF`, https://apps.microsoft.com/detail/9MW1KVP16BPF
- Identity (Partner Center > Product identity, public values, now defaults in `packaging/windows/build-store-package.sh`):
  Name `NeelK.AWPDFEditor`, Publisher `CN=76DAFE03-BFBD-42CC-843A-7413F60372B2`, PublisherDisplayName `Neel K`.
- **Built:** `dist/AW-PDF-Editor-0.1.0-windows-x64.msix` (108 MB, package version 0.1.0.0, unsigned; the Store signs it),
  sha256 `310a7f977468feb5713edb35ef7a1018814a0ef4f2ca9e95f6457dcb3a27ac16`. Identity checked inside the package.
  python-docx's unpacked template folder is left out (MSIX reserves the name `[Content_Types].xml`).
- Note: that rebuild also replaced `dist/…-setup.exe` with a new build (sha256 a0d396de…, same source). The copy
  on S3 and on the website is still the earlier one (6db47929…), and those two match each other. Don't upload
  the new local one without updating the page's checksum.
- Screenshots (1366x1020): `brand/store-art/AW-PDF-Editor-1-home.png`, `-2-document.png` (fictitious sample report).
- Next: Neel uploads the .msix and fills the listing from the text below. Change "Source code" to
  "on request at support@accredworks.com" until the GitHub repo is public. Certification notes: no account or sign-in;
  Office conversion needs Microsoft Office or LibreOffice installed (optional).
- Store copy of AW Signer: "Sign with DSC" passes the file through its `awsigner.exe` execution alias (added
  to AW Signer's Store manifest 2026-11-06, live only after AW Signer's next Store submission). A Store copy
  without the alias is started and the PDF is selected in File Explorer. Untested on Windows.

Product name to reserve in Partner Center (Neel does this, under the "Neel K" account): **AW PDF Editor**

## Short description (up to 100 characters)

Free PDF editor that works offline. Organise, convert, mark up, redact and OCR on your own PC.

## Description

AW PDF Editor does everyday PDF work on your own computer. Nothing is uploaded and you don't need an
account, so lab reports, ID copies and contracts stay with you.

- Organise pages: reorder, rotate, delete, crop, extract; merge files and split them.
- Create PDFs from photos, scans and Office files; export PDFs to Word, Excel, PowerPoint, images or text.
- Mark up: highlights, comments, drawings, stamps with your name and date, text, logos, form filling,
  watermarks and page numbers.
- Make scans searchable with built-in OCR for English, Assamese, Bengali and Hindi.
- Redact names, phone, Aadhaar and PAN numbers so they are removed from the file, not just covered.
- Correct a line of text (beta), reduce file size, and process a whole folder at once.

When a document needs a digital signature with your USB DSC token, "Sign with DSC" opens AW Signer.

AW PDF Editor is free software under the GNU Affero General Public License, version 3 or later.
Source code: github.com/neelsworld/aw-pdf-editor (to be published with the first release).

## What's new in this version

First release.

## Features (Store bullet list, up to 20)

Works offline · Free, no account · Merge and split PDFs · Reorder, rotate, crop pages · Convert Word, Excel,
images to PDF · Export PDF to Word and Excel · Highlight, comment, stamp · Fill forms · Watermark and page
numbers · OCR in English, Assamese, Bengali, Hindi · True redaction · Reduce file size · Batch processing

## Search terms (up to 7)

PDF editor, offline PDF, merge PDF, OCR, redact PDF, PDF to Word, Assamese OCR

## Category

Productivity

## Privacy policy URL

https://accredworks.com/privacy. Check that it covers AW PDF Editor (no data collected; files stay on the
device) before submitting.

## Packaging (to do)

- MSIX from the same staged files as the NSIS installer, following AW Signer's
  `windows/packaging/build-store-package.sh`. The `Identity Name` and `Publisher` come from Partner Center
  after the name is reserved.
- Store builds would turn off the app's own update check (the Store updates it).
- Declare the `.pdf` file type association in the manifest (uap:FileTypeAssociation) for "Open with".
