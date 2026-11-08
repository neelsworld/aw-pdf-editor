#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Sends a Developer-ID-signed DMG to Apple for notarisation, then staples the ticket to it.
# This uploads the file to Apple: run it only for a release you mean to publish.
#
#   packaging/notarize-mac.sh dist/AW-PDF-Editor-<version>-mac-<arch>.dmg
#
# AW_NOTARY_PROFILE: the name of a notarytool keychain profile (made once with
# `xcrun notarytool store-credentials`). Nothing secret is stored in this repository.
set -euo pipefail
DMG="${1:?Give the DMG built by packaging/build-mac.sh}"
PROFILE="${AW_NOTARY_PROFILE:?Set AW_NOTARY_PROFILE to your notarytool keychain profile name}"
codesign --verify --strict "$DMG"
xcrun notarytool submit "$DMG" --keychain-profile "$PROFILE" --wait
xcrun stapler staple "$DMG"
xcrun stapler validate "$DMG"
spctl --assess --type open --context context:primary-signature -v "$DMG" || true
echo "Notarised and stapled: $DMG"
