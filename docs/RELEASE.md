# Releasing AW PDF Editor

Everything up to "Build" runs on this Mac and changes nothing outside it. **Every step marked 🔒 is
outward-facing (it publishes, uploads or makes something public) and needs Neel's explicit go-ahead,
one step at a time.**

## 1. Build

```sh
packaging/build-mac.sh                 # dist/AW-PDF-Editor-<version>-mac-<arch>.dmg (ad-hoc signed)
AW_DEVELOPER_ID="Developer ID Application: … (…)" packaging/build-mac.sh   # Developer ID signed
packaging/windows/build-windows.sh     # dist/AW-PDF-Editor-<version>-windows-x64-setup.exe (not signed)
```

The Developer ID is the same one AW Signer uses (its build reads `AW_SIGNER_DEVELOPER_ID`, which this
script also accepts). Nothing secret is stored in the repository.

Before every release:

- [ ] `worker/.venv/bin/python -m unittest discover -s worker/tests` and `cargo test` (in `app/src-tauri`) pass
- [ ] Licences re-checked on the web (THIRD_PARTY_NOTICES.md), including OpenCV's bundled libraries
- [ ] Tried by hand on a Mac and on a Windows PC: open, organise, save, mark up, OCR, redact, export, Sign with DSC
- [ ] Version bumped in `app/src-tauri/Cargo.toml` and `tauri.conf.json` (the editor's own version only)

## 2. Mac: notarise 🔒

```sh
AW_NOTARY_PROFILE=<keychain profile> packaging/notarize-mac.sh dist/AW-PDF-Editor-<version>-mac-arm64.dmg
```

This uploads the DMG to Apple. Simplest is one command that signs, notarises and staples both the app
and the DMG (the app is stapled too, so it opens offline after being dragged out):

```sh
AW_DEVELOPER_ID="Developer ID Application: <Your Name> (<TEAMID>)" AW_NOTARY_PROFILE=AW-NOTARY packaging/build-mac.sh
```

The keychain profile is made once by Neel in Terminal (it asks for an app-specific password from
account.apple.com; nothing is stored in the repository):
`xcrun notarytool store-credentials AW-NOTARY --apple-id <Apple ID e-mail> --team-id K55UG2L7X4`.
The `AW-NOTARY` profile exists on Neel's Mac (the same one AW Signer uses), but Claude's shell can't read
it, so **Neel runs the notarised build in his own Terminal**, as for AW Signer. First notarised on
2026-11-05 (both submissions Accepted; `spctl`: "Notarized Developer ID"). An Intel build needs to be made on an Intel Mac, or as a universal build later.

## 3. Source code: public repository (done 2026-11-08: github.com/neelsworld/aw-pdf-editor, tag v0.1.1)

AGPL requires the exact source of each release to be available.

1. Create `github.com/neelsworld/aw-pdf-editor` (public).
2. First commit of `desktop/` (it's already its own git repo, with nothing committed yet). Check it holds
   no secrets, no private test PDFs, and no AW Signer token, lease or backend code.
3. Tag the release (`v<version>`) and push the tag.
4. The site's download page links to that tag's source.

## 4. Host the installers 🔒 (0.1.0 done 2026-11-05)

Upload the DMG and the setup .exe next to AW Signer's (downloads.accredworks.com), e.g. under
`aw-pdf-editor/macos/` and `aw-pdf-editor/windows/`. Publish SHA-256 sums with them. Upload with `aws s3 cp <file> s3://accredworks-aw-signer-downloads-<account>/aw-pdf-editor/<os>/ --region ap-south-1 --content-type …` (DMG: `application/x-apple-diskimage`, exe: `application/vnd.microsoft.portable-executable`) after `aws login --region ap-south-1`. Old versions stay, so shared links keep working.

## 5. Website 🔒 (0.1.0 live 2026-11-05, site commit b777c82)

The live page is `01_AW_Signer/site/pdf-editor.html` (the draft in `docs/site-draft/` is superseded). For a new
release, update its two download links, sizes, version and SHA-256 sums, then commit in the site repo
(`neelsworld/accredworks-site`). Pushing to `main` deploys it (Dokploy). Also add a link from the AW
Signer pages, and check that `/privacy` covers AW PDF Editor.

## 6. Microsoft Store 🔒

1. Reserve the name "AW PDF Editor" in Partner Center ("Neel K" account). Neel does this.
2. Build an MSIX (follow AW Signer's `windows/packaging/build-store-package.sh`, with the Identity values
   from Partner Center and a `.pdf` file-type association).
3. Listing text: `docs/STORE-LISTING.md`. Submit for certification.

## Not in this release yet

- **"Sign with DSC" end to end.** The editor passes the saved PDF's path to AW Signer. Only AW Signer
  builds from 2026-11-05 on load it (see `01_AW_Signer/OPEN-FILE-HANDOFF.md`). Try it once both are
  built. AW Signer for Windows now forwards a second launch to the open window (single-instance, 2026-11-06).
  Mac AW Signer 2.6.2 and older, and the Store copy, are started without the file and the PDF is shown in its folder.
- **In-app update check.** Planned as optional and off by default for Store builds.
- **Windows code signing** (SmartScreen shows a warning until the installer is signed, as with AW Signer's
  .exe). The Store build doesn't need it.
