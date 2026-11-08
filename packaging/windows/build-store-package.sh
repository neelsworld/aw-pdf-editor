#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Builds the Microsoft Store package (.msix) of AW PDF Editor from the files build-windows.sh staged, so run
# that first. The package is unsigned: the Store signs it after certification.
#
#   packaging/windows/build-store-package.sh
#
# The identity values come from Partner Center > Product identity (public, not secrets). The official
# AccredWorks ones are the defaults; forks must use their own (see TRADEMARKS.md):
#   AW_STORE_IDENTITY_NAME   Package/Identity/Name
#   AW_STORE_PUBLISHER       Package/Identity/Publisher        (CN=...)
#   AW_STORE_PUBLISHER_NAME  Package/Properties/PublisherDisplayName
# Or AW_STORE_TEST=1 for an unsigned copy to try on a Windows 10/11 PC. Its publisher carries Microsoft's
# "unsigned package" OID, so an administrator PowerShell installs it with
#   Add-AppxPackage -Path <file>.msix -AllowUnsigned
#
# MAKEMSIX: Microsoft's open-source packer (github.com/microsoft/msix-packaging, built with makemac.sh --pack).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
BUILD_CACHE="${BUILD_CACHE:-$HOME/Library/Caches/aw-pdf-editor-windows-build}"
STAGE="$BUILD_CACHE/stage"
DIST="$ROOT/dist"
MAKEMSIX="${MAKEMSIX:-$(find "$HOME/Library/Caches/msix-packaging/.vs" -name makemsix -type f -perm +111 2>/dev/null | head -1)}"
VERSION="$(sed -n 's/^version = "\(.*\)"/\1/p' "$ROOT/app/src-tauri/Cargo.toml" | head -1)"
# The branded icon from build-windows.sh's build copy; the working tree only has the neutral placeholder.
ICON="$BUILD_CACHE/src/app/src-tauri/icons/icon.png"
[ -f "$ICON" ] || ICON="$ROOT/app/src-tauri/icons/icon.png"

if [ "${AW_STORE_TEST:-}" = 1 ]; then
  AW_STORE_IDENTITY_NAME="AccredWorks.AWPDFEditor.Test"
  AW_STORE_PUBLISHER="CN=AW PDF Editor Test, OID.2.25.311729368913984317654407730594956997722=1"
  AW_STORE_PUBLISHER_NAME="AW PDF Editor Test"
  SUFFIX="-test"
else
  : "${AW_STORE_IDENTITY_NAME:=NeelK.AWPDFEditor}" "${AW_STORE_PUBLISHER:=CN=76DAFE03-BFBD-42CC-843A-7413F60372B2}" "${AW_STORE_PUBLISHER_NAME:=Neel K}"
  SUFFIX=""
fi
[ -x "$MAKEMSIX" ] || { echo "makemsix not found. Build msix-packaging with makemac.sh --pack, or set MAKEMSIX." >&2; exit 1; }
[ -f "$STAGE/AW PDF Editor.exe" ] || { echo "No staged app at $STAGE. Run packaging/windows/build-windows.sh first." >&2; exit 1; }

# The Store wants four numbers with the last one 0: 0.1.0 -> 0.1.0.0.
PACKAGE_VERSION="$(printf '%s' "$VERSION" | sed 's/[-+].*//' | awk -F. '{printf "%d.%d.%d.0", $1, $2, $3}')"

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
PKG="$WORK/package"
mkdir -p "$PKG/Assets"
cp -R "$STAGE"/. "$PKG/"
rm -f "$PKG/README.txt" "$PKG/AW PDF Editor.ico"   # installer-only files
# MSIX reserves the name "[Content_Types].xml". python-docx ships an unpacked copy of its Word template that
# contains one; it only ever loads templates/default.docx and the single default-*.xml files, so drop the folder.
rm -rf "$PKG/aw-pdf-worker/lib/docx/templates/default-docx-template"
sips -z 44 44 "$ICON" --out "$PKG/Assets/Square44x44Logo.png" >/dev/null
sips -z 150 150 "$ICON" --out "$PKG/Assets/Square150x150Logo.png" >/dev/null
sips -z 50 50 "$ICON" --out "$PKG/Assets/StoreLogo.png" >/dev/null
# Wide tile: the icon centred on a transparent 310x150 canvas.
sips -z 150 150 "$ICON" --out "$WORK/wide-icon.png" >/dev/null
sips -p 150 310 "$WORK/wide-icon.png" --out "$PKG/Assets/Wide310x150Logo.png" >/dev/null

escape() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/"/\&quot;/g' -e 's/</\&lt;/g' -e 's/[\/|]/\\&/g'; }
sed -e "s|@IDENTITY_NAME@|$(escape "$AW_STORE_IDENTITY_NAME")|" \
    -e "s|@PUBLISHER@|$(escape "$AW_STORE_PUBLISHER")|" \
    -e "s|@PUBLISHER_DISPLAY_NAME@|$(escape "$AW_STORE_PUBLISHER_NAME")|" \
    -e "s|@VERSION@|$PACKAGE_VERSION|" "$HERE/AppxManifest.xml" > "$PKG/AppxManifest.xml"
xattr -cr "$PKG"

OUT="$DIST/AW-PDF-Editor-$VERSION-windows-x64$SUFFIX.msix"
mkdir -p "$DIST"
rm -f "$OUT"
"$MAKEMSIX" pack -d "$PKG" -p "$OUT"
[ -f "$OUT" ] || { echo "The package was not made. Stopping."; exit 1; }
echo "Built: $OUT ($PACKAGE_VERSION, $(du -h "$OUT" | cut -f1))"
shasum -a 256 "$OUT"
