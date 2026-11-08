#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Builds the AW PDF Editor for Windows installer on a Mac, without a Windows machine (the same approach
# as AW Signer's windows/packaging/build-windows-installer.sh).
#
#   packaging/windows/build-windows.sh
#
# Output: dist/AW-PDF-Editor-<version>-windows-x64-setup.exe (not code-signed yet).
#
# Needs (as for AW Signer): Homebrew nsis, llvm and lld; `cargo install cargo-xwin`; the Rust target
# x86_64-pc-windows-msvc. Downloads go to a cache folder outside the project (BUILD_CACHE).
#
# What goes in the installer:
#   AW PDF Editor.exe   the Tauri window, cross-built (branded build copy, like build-mac.sh)
#   aw-pdf-worker\      Windows' embeddable Python 3.12, the worker packages (win_amd64 wheels),
#                       the worker code and the OCR language data
set -euo pipefail

PYTHON_VERSION="3.12.10"
PYTHON_ZIP="python-${PYTHON_VERSION}-embed-amd64.zip"
PYTHON_MD5="fe8ef205f2e9c3ba44d0cf9954e1abd3" # as published on python.org (same as AW Signer's)

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
BUILD_CACHE="${BUILD_CACHE:-$HOME/Library/Caches/aw-pdf-editor-windows-build}"
STAGE="$BUILD_CACHE/stage"
DIST="$ROOT/dist"
PYTHON_FOR_PIP="${PYTHON_FOR_PIP:-$ROOT/worker/.venv/bin/python}"
export PATH="/opt/homebrew/opt/llvm/bin:/opt/homebrew/opt/lld/bin:$HOME/.cargo/bin:$PATH"
for tool in makensis cargo-xwin lld-link llvm-rc; do
  command -v "$tool" >/dev/null || { echo "Missing build tool: $tool (see the top of this script)"; exit 1; }
done
VERSION="$(sed -n 's/^version = "\(.*\)"/\1/p' "$ROOT/app/src-tauri/Cargo.toml" | head -1)"
echo "Building AW PDF Editor $VERSION for Windows"
mkdir -p "$BUILD_CACHE/downloads" "$BUILD_CACHE/wheels" "$DIST"

echo "== 1. Windows embeddable Python $PYTHON_VERSION"
if [ ! -f "$BUILD_CACHE/downloads/$PYTHON_ZIP" ]; then
  curl -sSfL -o "$BUILD_CACHE/downloads/$PYTHON_ZIP" "https://www.python.org/ftp/python/$PYTHON_VERSION/$PYTHON_ZIP"
fi
if [ "$(md5 -q "$BUILD_CACHE/downloads/$PYTHON_ZIP")" != "$PYTHON_MD5" ]; then
  echo "Checksum of $PYTHON_ZIP does not match python.org. Stopping."; exit 1
fi

echo "== 2. Worker packages for 64-bit Windows"
"$PYTHON_FOR_PIP" -m pip download --quiet --only-binary=:all: --platform win_amd64 --python-version 3.12 \
  --implementation cp --abi cp312 --abi abi3 --abi none --no-deps -d "$BUILD_CACHE/wheels" -r "$HERE/worker-requirements-win.txt"

echo "== 3. Stage the worker"
rm -rf "$STAGE"
WORKER="$STAGE/aw-pdf-worker"
mkdir -p "$WORKER/python" "$WORKER/lib" "$WORKER/src"
unzip -q "$BUILD_CACHE/downloads/$PYTHON_ZIP" -d "$WORKER/python"
# Embedded Python reads its import paths from this file only (it ignores PYTHONPATH and user folders).
printf 'python312.zip\r\n.\r\n..\\lib\r\n..\\src\r\n' > "$WORKER/python/python312._pth"
for wheel in "$BUILD_CACHE"/wheels/*.whl; do
  unzip -q -o "$wheel" -d "$WORKER/lib"
done
rsync -a --exclude '__pycache__' "$ROOT/worker/src/aw_pdf_worker" "$WORKER/src/"
rsync -a "$ROOT/worker/tessdata/" "$WORKER/tessdata/"

echo "== 4. The window (Rust, cross-compiled, from a branded build copy)"
rm -rf "$BUILD_CACHE/src"
rsync -a --exclude 'app/src-tauri/target' --exclude 'worker/.venv' --exclude 'worker/dist' --exclude 'worker/build' \
  --exclude 'dist' --exclude '.git' "$ROOT/" "$BUILD_CACHE/src/"
if [ -d "$ROOT/brand" ]; then "$ROOT/packaging/apply-brand.sh" "$BUILD_CACHE/src"; fi
( cd "$BUILD_CACHE/src/app/src-tauri" && CARGO_TARGET_DIR="$BUILD_CACHE/target" cargo xwin build --release --target x86_64-pc-windows-msvc )
cp "$BUILD_CACHE/target/x86_64-pc-windows-msvc/release/aw-pdf-editor.exe" "$STAGE/AW PDF Editor.exe"
cp "$BUILD_CACHE/src/app/src-tauri/icons/icon.ico" "$STAGE/AW PDF Editor.ico"
cp "$ROOT/LICENSE" "$STAGE/LICENSE.txt"
cp "$ROOT/THIRD_PARTY_NOTICES.md" "$ROOT/TRADEMARKS.md" "$STAGE/"
cat > "$STAGE/README.txt" <<EOF
AW PDF Editor $VERSION for Windows, by AccredWorks. https://accredworks.com/pdf-editor
Free software under the GNU AGPL, version 3 or later (LICENSE.txt). No warranty.
Word, Excel and PowerPoint files are turned into PDFs with Microsoft Office or LibreOffice, if installed.
EOF

echo "== 5. Make the installer"
OUT="$DIST/AW-PDF-Editor-$VERSION-windows-x64-setup.exe"
rm -f "$OUT"
makensis -V2 -DVERSION="$VERSION" -DSTAGE="$STAGE" -DOUTFILE="$OUT" "$HERE/installer.nsi" || true
if [ ! -f "$OUT" ]; then  # makensis can exit 0 without writing a file; try again, showing its output
  makensis -V3 -DVERSION="$VERSION" -DSTAGE="$STAGE" -DOUTFILE="$OUT" "$HERE/installer.nsi"
fi
[ -f "$OUT" ] || { echo "The installer was not made (see makensis output above). Stopping."; exit 1; }
echo
echo "Built: $OUT ($(du -h "$OUT" | cut -f1))"
shasum -a 256 "$OUT"
