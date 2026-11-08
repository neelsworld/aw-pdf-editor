#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Builds "AW PDF Editor.app" and a DMG for macOS (Apple Silicon or Intel: whatever this Mac is).
#
#   packaging/build-mac.sh
#
# Output: dist/AW-PDF-Editor-<version>-mac-<arch>.dmg
#
# Official AccredWorks builds carry the AW logo (brand/, not AGPL): the repo is copied to a build folder
# and branded there, so the working tree keeps its neutral placeholder icons.
#
# Signing (nothing secret is stored here; the names come from the environment):
#   AW_DEVELOPER_ID   e.g. "Developer ID Application: <name> (<team>)". Unset: ad-hoc signature, for
#                     testing on this Mac only. (AW_SIGNER_DEVELOPER_ID, AW Signer's, is used if set.)
# Notarising uploads to Apple, so it only happens when AW_NOTARY_PROFILE (a notarytool keychain profile,
# e.g. AW Signer's "AW-NOTARY") is also set. It then notarises and staples both the app and the DMG.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="${BUILD_CACHE:-$HOME/Library/Caches/aw-pdf-editor-build}"
DIST="$ROOT/dist"
VERSION="$(sed -n 's/^version = "\(.*\)"/\1/p' "$ROOT/app/src-tauri/Cargo.toml" | head -1)"
ARCH="$(uname -m)"
IDENTITY="${AW_DEVELOPER_ID:-${AW_SIGNER_DEVELOPER_ID:-}}"
APP="$BUILD/AW PDF Editor.app"
mkdir -p "$BUILD" "$DIST"
echo "Building AW PDF Editor $VERSION for macOS ($ARCH)"

echo "== 1. Branded build copy"
rm -rf "$BUILD/src"
rsync -a --exclude 'app/src-tauri/target' --exclude 'worker/.venv' --exclude 'worker/dist' --exclude 'worker/build' \
  --exclude 'dist' --exclude '.git' "$ROOT/" "$BUILD/src/"
if [ -d "$ROOT/brand" ]; then
  "$ROOT/packaging/apply-brand.sh" "$BUILD/src"
else
  echo "   (no brand/ folder: building with the neutral placeholder icon)"
fi

echo "== 2. The window (Rust)"
( cd "$BUILD/src/app/src-tauri" && CARGO_TARGET_DIR="$BUILD/target" cargo build --release )

echo "== 3. The worker (Python + PyMuPDF, with OCR language data)"
"$ROOT/packaging/build-worker.sh" >/dev/null

echo "== 4. Assemble the app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BUILD/target/release/aw-pdf-editor" "$APP/Contents/MacOS/aw-pdf-editor"
cp -R "$ROOT/worker/dist/aw-pdf-worker" "$APP/Contents/Resources/aw-pdf-worker"
ICNS="$BUILD/src/brand/icons/icon.icns"
if [ -f "$ICNS" ]; then cp "$ICNS" "$APP/Contents/Resources/icon.icns"; else
  # placeholder icon from the PNG (forks without brand/)
  mkdir -p "$BUILD/icon.iconset"
  for s in 16 32 128 256 512; do sips -z $s $s "$ROOT/app/src-tauri/icons/icon.png" --out "$BUILD/icon.iconset/icon_${s}x${s}.png" >/dev/null; done
  iconutil -c icns "$BUILD/icon.iconset" -o "$APP/Contents/Resources/icon.icns"
fi
cp "$ROOT/LICENSE" "$ROOT/THIRD_PARTY_NOTICES.md" "$ROOT/TRADEMARKS.md" "$APP/Contents/Resources/"
cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>AW PDF Editor</string>
  <key>CFBundleDisplayName</key><string>AW PDF Editor</string>
  <key>CFBundleIdentifier</key><string>com.accredworks.aw-pdf-editor</string>
  <key>CFBundleExecutable</key><string>aw-pdf-editor</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>AccredWorks. Free software under the GNU AGPL 3.0 or later.</string>
  <!-- Listed under Finder's "Open with" for PDFs, without taking over as the default viewer. -->
  <key>CFBundleDocumentTypes</key>
  <array>
    <dict>
      <key>CFBundleTypeName</key><string>PDF document</string>
      <key>CFBundleTypeRole</key><string>Editor</string>
      <key>LSHandlerRank</key><string>Alternate</string>
      <key>LSItemContentTypes</key><array><string>com.adobe.pdf</string></array>
    </dict>
  </array>
</dict>
</plist>
EOF

echo "== 5. Sign"
xattr -cr "$APP"   # synced folders add Finder metadata that codesign rejects
if [ -n "$IDENTITY" ]; then
  # Apple's timestamp server sometimes doesn't answer; a signature without a timestamp fails notarisation.
  sign() {
    for attempt in 1 2 3 4; do
      if codesign --force --options runtime --timestamp --sign "$IDENTITY" "$@"; then return 0; fi
      echo "   (signing failed, trying again in 5 s)"; sleep 5
    done
    echo "Could not sign: $*"; exit 1
  }
  WORKER_DIR="$APP/Contents/Resources/aw-pdf-worker"
  # Inside out: every Mach-O file in the worker (found by type, not by name), the worker, the window, the app.
  find "$WORKER_DIR" -type f ! -path "$WORKER_DIR/aw-pdf-worker" > "$BUILD/worker-files.txt"
  count=0
  while IFS= read -r f; do
    if file -b "$f" | grep -q "Mach-O"; then sign "$f" 2>/dev/null; count=$((count + 1)); fi
  done < "$BUILD/worker-files.txt"
  echo "   signed $count worker libraries"
  sign "$WORKER_DIR/aw-pdf-worker"
  sign "$APP/Contents/MacOS/aw-pdf-editor"
  sign "$APP"
  codesign --verify --deep --strict "$APP"
  echo "   signed with: $IDENTITY"
  if [ -n "${AW_NOTARY_PROFILE:-}" ]; then
    # Uploads the app to Apple. Notarise the app itself and staple the ticket, so it also opens offline
    # after being dragged out of the DMG (as AW Signer's build does).
    echo "   notarising the app (uploads to Apple)…"
    ditto -c -k --keepParent "$APP" "$BUILD/notarize-app.zip"
    xcrun notarytool submit "$BUILD/notarize-app.zip" --keychain-profile "$AW_NOTARY_PROFILE" --wait
    xcrun stapler staple "$APP"
    rm -f "$BUILD/notarize-app.zip"
  fi
else
  codesign --force --deep --sign - "$APP"
  echo "   ad-hoc signature (set AW_DEVELOPER_ID for a Developer ID signature)"
fi

echo "== 6. DMG"
DMG="$DIST/AW-PDF-Editor-$VERSION-mac-$ARCH.dmg"
rm -rf "$BUILD/dmg" "$DMG"
mkdir -p "$BUILD/dmg"
cp -R "$APP" "$BUILD/dmg/"
ln -s /Applications "$BUILD/dmg/Applications"
# hdiutil sometimes fails with "Resource busy" right after a copy; try a few times.
for attempt in 1 2 3; do
  if hdiutil create -volname "AW PDF Editor" -srcfolder "$BUILD/dmg" -ov -format UDZO "$DMG"; then break; fi
  [ "$attempt" = 3 ] && { echo "Could not make the DMG."; exit 1; }
  sleep 3
done
if [ -n "$IDENTITY" ]; then codesign --force --timestamp --sign "$IDENTITY" "$DMG"; fi
echo
echo "Built: $DMG ($(du -h "$DMG" | cut -f1))"
shasum -a 256 "$DMG"
if [ -n "$IDENTITY" ] && [ -n "${AW_NOTARY_PROFILE:-}" ]; then
  "$ROOT/packaging/notarize-mac.sh" "$DMG"
elif [ -n "$IDENTITY" ]; then
  echo "Next: packaging/notarize-mac.sh \"$DMG\" (uploads to Apple)"
fi
