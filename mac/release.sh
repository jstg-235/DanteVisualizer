#!/bin/zsh
# Build a signed, notarized "Dante Visualizer.dmg" for sharing.
#
#   mac/release.sh                 build, sign with Developer ID, notarize, staple
#   mac/release.sh --no-notarize   build and sign only (for a quick check)
#
# Needs, once per Mac:
#   1. A "Developer ID Application" certificate in the login keychain.
#   2. A notarytool keychain profile, made with:
#        xcrun notarytool store-credentials dantevisualizer --apple-id <id> --team-id <TEAMID>
#      (it asks for an app-specific password from account.apple.com)
# Optional environment: DV_SIGN_ID (signing identity), DV_NOTARY_PROFILE (default dantevisualizer),
# DV_BUNDLE_ID (default com.newconstellation.dantevisualizer).
set -euo pipefail
cd "$(dirname "$0")"
PROFILE=${DV_NOTARY_PROFILE:-dantevisualizer}
SIGN_ID=${DV_SIGN_ID:-$(security find-identity -v -p codesigning | awk -F'"' '/Developer ID Application/{print $2; exit}')}
if [[ -z "$SIGN_ID" ]]; then
  echo "No 'Developer ID Application' certificate found in the keychain." >&2
  exit 1
fi
echo "Signing identity: $SIGN_ID"

DV_EMBED_PYTHON=1 DV_BUNDLE_ID=${DV_BUNDLE_ID:-com.newconstellation.dantevisualizer} ./build_app.sh
APP="build/Dante Visualizer.app"
VERSION=$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$APP/Contents/Info.plist")
DMG="build/Dante Visualizer $VERSION.dmg"

echo "Signing with Developer ID (hardened runtime)…"
# Every native file inside (Python, its extension modules, netaudio's daemon) first, then the app.
find "$APP/Contents/Resources" -type f \( -perm +111 -o -name '*.so' -o -name '*.dylib' \) -print0 |
  while IFS= read -r -d '' f; do
    if file -b "$f" | grep -q Mach-O; then
      codesign --force --options runtime --timestamp --entitlements entitlements.plist --sign "$SIGN_ID" "$f"
    fi
  done
codesign --force --options runtime --timestamp --sign "$SIGN_ID" "$APP/Contents/MacOS/DanteVisualizer"
codesign --force --options runtime --timestamp --sign "$SIGN_ID" "$APP"
codesign --verify --strict --verbose=2 "$APP"

echo "Making $DMG…"
STAGE=$(mktemp -d)
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
rm -f "$DMG"
hdiutil create -volname "Dante Visualizer" -srcfolder "$STAGE" -fs HFS+ -format UDZO -ov "$DMG" >/dev/null
rm -rf "$STAGE"
codesign --force --timestamp --sign "$SIGN_ID" "$DMG"

if [[ "${1:-}" != "--no-notarize" ]]; then
  echo "Notarizing (usually a few minutes)…"
  xcrun notarytool submit "$DMG" --keychain-profile "$PROFILE" --wait
  xcrun stapler staple "$DMG"
  xcrun stapler validate "$DMG"
  spctl -a -t open --context context:primary-signature -vv "$DMG"
fi
echo "Done: mac/$DMG"
