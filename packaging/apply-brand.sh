#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Official AccredWorks builds only: copies the AW logo and icons from brand/ (all rights reserved, not
# AGPL) over the neutral placeholders, in a BUILD COPY of the repo. Never run it on your working tree:
# the placeholders must stay what is committed.
#   usage: packaging/apply-brand.sh <build-copy-folder>
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${1:?Give the build copy folder, e.g. /tmp/aw-pdf-editor-build}"
TARGET="$(cd "$TARGET" && pwd)"
if [ "$TARGET" = "$ROOT" ]; then
  echo "Refusing to brand the working tree. Copy the repo first and pass the copy." >&2
  exit 1
fi
cp "$ROOT/brand/icons/32x32.png" "$ROOT/brand/icons/128x128.png" "$ROOT/brand/icons/icon.png" \
   "$ROOT/brand/icons/icon.ico" "$ROOT/brand/icons/icon.icns" "$TARGET/app/src-tauri/icons/"
cp "$ROOT/brand/brand-mark.png" "$TARGET/app/ui/brand-mark.png"
echo "Brand applied to $TARGET"
