# Phase 5 report: Release preparation (2026-11-05)

Everything that can be done on this Mac without publishing anything is done. The outward steps
(notarising, the public repo, hosting, the site page, the Store) each wait for Neel's go-ahead. The list
is in `RELEASE.md`.

## What was added

| Item | What it does |
|---|---|
| **Sign with DSC** | Button in the action bar (prominent, as decided in D4). It saves first if needed, then hands the saved PDF to AW Signer (only the path is passed). Mac: `open -b com.accredworks.aw-signer-v2 <file>`, but if `/Applications` or `~/Applications` holds an AW Signer whose Info.plist has no `CFBundleDocumentTypes` (2.6.2 and older), it starts AW Signer without the file and selects the PDF in Finder instead, so old versions never get a file they can't open. Windows: `%LOCALAPPDATA%\Programs\AW Signer\AW Signer.exe <file>`; for the Microsoft Store install it runs the `%LOCALAPPDATA%\Microsoft\WindowsApps\awsigner.exe <file>` alias (AW Signer Store builds after 2026-11-06); a Store copy without the alias (found by `%LOCALAPPDATA%\Packages\NeelK.AWSigner_*`) it starts `shell:AppsFolder\<family>!AWSigner` and selects the PDF in File Explorer. The message says older AW Signer versions don't take the file directly and offers "Show in folder". If AW Signer isn't installed, it offers the download page and "Show in folder". Updated 2026-11-06 |
| **Open with** | The Mac app lists itself under Finder's "Open with" for PDFs, and the Windows installer adds it to "Open with", in both cases **without** becoming the default PDF app. Files given at launch, or opened while the app is running, open in tabs |
| **Mac build** | `packaging/build-mac.sh` makes `AW PDF Editor.app` and a DMG from a branded copy of the source (the working tree keeps neutral icons). It signs with the Developer ID if one is named in the environment, otherwise with an ad-hoc signature for testing on this Mac |
| **Mac notarising** | `packaging/notarize-mac.sh` (uploads to Apple, so it only runs on Neel's go-ahead) |
| **Windows build** | `packaging/windows/build-windows.sh` cross-builds on this Mac, the same way as AW Signer. It uses Windows' embeddable Python 3.12.10 (checksum checked), the worker's Windows wheels, the worker code and OCR data, the cross-compiled window, and an NSIS per-user installer with a licence page and an uninstaller |
| **Release checklist** | `docs/RELEASE.md`, with 🔒 on every outward step |
| **Store listing text** | `docs/STORE-LISTING.md` |
| **Site page draft** | `docs/site-draft/pdf-editor.html` (accredworks.com/pdf-editor, in the site's style, download links left blank) |

## Built files (in `dist/`, not in git)

| File | Size | SHA-256 |
|---|---|---|
| `AW-PDF-Editor-0.1.0-mac-arm64.dmg` (Developer ID signed, **notarised and stapled**, app and DMG; 2026-11-05) | 111 MB | `f4177e2bcfdcc5b5c9a300227620679c8be8d835489383c6447de3c669e6a210` |
| `AW-PDF-Editor-0.1.0-windows-x64-setup.exe` (not code-signed) | 78 MB | `6db47929a927c244a2704e59460112f0eb5d57aa5dad0ff2a00719020f93b26a` (rebuilt 2026-11-05 evening, with the file hand-off) |

Both are well inside the 150–200 MB budget.

## Checked

- Mac: the bundle signature verifies. The packed worker answers a ping from inside the .app, and the OCR
  data is in place. The app starts. **Its window was not looked at in the built app** (screen access to it
  was declined); the same UI was tested end to end in the browser harness against the real worker in
  Phases 1–4.
- Windows: the installer is a valid NSIS Windows program. The staged contents were checked: the window,
  the embedded Python with its import-path file, the worker packages, the worker code and the four OCR
  languages. **Not yet installed or run on a Windows PC.** That, and Office conversion through
  Microsoft Office, need a real Windows machine.
- Worker tests (65) and `cargo test` pass.

## Problems found and fixed

- **makensis wrote no installer but reported success.** Homebrew's makensis on this Mac silently fails to
  write a *solid* LZMA installer this large (~290 MB staged). It switched to non-solid LZMA (+4 MB).
  The build script now also stops with a clear message if the file is missing.
- `hdiutil` sometimes fails with "Resource busy" right after copying; the DMG step retries.
- `set -e` together with `[ … ] && …` ended the script early; replaced with `if`.
- Signing: Apple's timestamp server failed once; `sign` now retries. Binaries are found by type (any Mach-O, 204 in the worker), not by `.so`/`.dylib` name, as AW Signer does.
- `apply-brand.sh` refuses to run on the working tree, so the AW logo (not AGPL) never ends up in it.

## Not done in this phase

- Windows code signing (SmartScreen will warn, as it does for AW Signer's .exe), and the MSIX for the Store.
- The in-app update check (planned as optional and off by default for Store builds).
- The hand-off end to end: AW Signer's side was added on 2026-11-05 (`01_AW_Signer/OPEN-FILE-HANDOFF.md`),
  but it only arrives with AW Signer's next release, so passing a file into a real AW Signer hasn't been
  tried yet. Both installers include the hand-off.
- An Intel Mac build (needs an Intel Mac, or a universal build later).

## Note for this Mac

The startup disk is nearly full (3.7 GB free of 460 GB). The build caches take about 2.9 GB:
`~/Library/Caches/aw-pdf-editor-build` and `~/Library/Caches/aw-pdf-editor-windows-build`. They can be
deleted at any time, and the next build recreates them.
