#!/bin/bash
set -euo pipefail
app="${1:-$HOME/.claude/cloud-pet/CloudPet.app}"
tmp="$(mktemp -d)/CloudPet.app"
mkdir -p "$tmp/Contents/MacOS" "$(dirname "$app")"
swiftc -O -o "$tmp/Contents/MacOS/CloudPet" "$(dirname "$0")/CloudPet.swift"
cat > "$tmp/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>local.cloud-pet</string>
<key>CFBundleName</key><string>Cloud</string>
<key>CFBundleExecutable</key><string>CloudPet</string>
<key>LSUIElement</key><true/>
</dict></plist>
PLIST
codesign --force --sign - "$tmp"
rm -rf "$app"
mv "$tmp" "$app"
