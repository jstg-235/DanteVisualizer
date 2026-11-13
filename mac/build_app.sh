#!/bin/zsh
# Build "Dante Visualizer.app" with the Command Line Tools only (no Xcode needed).
#
#   mac/build_app.sh             builds mac/build/Dante Visualizer.app
#   mac/build_app.sh --install   also copies it to ~/Applications
#
# The app carries the web page, server and engine scripts in Contents/Resources/engine.
# On first launch it makes its own Python environment with netaudio in
# ~/Library/Application Support/Dante Visualizer/venv (needs Python 3.10+ from python.org
# and an internet connection once).
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$(cd .. && pwd)
APP="build/Dante Visualizer.app"
VERSION=$(git -C "$ROOT" describe --tags --always 2>/dev/null || echo dev)

echo "Compiling…"
swift build -c release --arch arm64
BIN=$(swift build -c release --arch arm64 --show-bin-path)/DanteVisualizer

echo "Assembling $APP…"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/engine"
cp "$BIN" "$APP/Contents/MacOS/DanteVisualizer"
rsync -a --exclude '.venv' --exclude '__pycache__' --exclude '*.json' --exclude '*.log' --exclude '*.pcap' \
  "$ROOT/web" "$ROOT/server" "$ROOT/probe" "$ROOT/requirements.txt" "$APP/Contents/Resources/engine/"

# App icon: mac/AppIcon.png (1024 px) → AppIcon.icns with the built-in sips and iconutil.
if [[ -f AppIcon.png ]]; then
  ICONSET=$(mktemp -d)/AppIcon.iconset
  mkdir -p "$ICONSET"
  for s in 16 32 128 256 512; do
    sips -z $s $s AppIcon.png --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
    sips -z $((s*2)) $((s*2)) AppIcon.png --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"
  rm -rf "$(dirname "$ICONSET")"
fi

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Dante Visualizer</string>
  <key>CFBundleDisplayName</key><string>Dante Visualizer</string>
  <key>CFBundleIdentifier</key><string>local.dantevisualizer.app</string>
  <key>CFBundleExecutable</key><string>DanteVisualizer</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleShortVersionString</key><string>0.4</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.music</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>Reads Dante networks; never changes routes or settings.</string>
  <key>NSLocalNetworkUsageDescription</key>
  <string>Dante Visualizer finds Dante devices on your network and reads their channels, routes and signal levels.</string>
  <key>NSBonjourServices</key>
  <array>
    <string>_netaudio-arc._udp</string>
    <string>_netaudio-cmc._udp</string>
    <string>_netaudio-dbc._udp</string>
    <string>_netaudio-chan._udp</string>
  </array>
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
PLIST

echo "Signing (ad hoc)…"
codesign --force --deep --sign - "$APP"

if [[ "${1:-}" == "--install" ]]; then
  mkdir -p ~/Applications
  rm -rf ~/Applications/"Dante Visualizer.app"
  cp -R "$APP" ~/Applications/
  echo "Installed to ~/Applications/Dante Visualizer.app"
fi
echo "Done: mac/$APP"
