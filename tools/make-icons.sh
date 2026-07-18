#!/bin/sh
# Regenerates icons/icon{16,32,48,128}.png from tools/icon.svg.
# macOS only (uses QuickLook + sips). Run from the repo root:
#   sh tools/make-icons.sh
set -e
cd "$(dirname "$0")/.."
TMP=$(mktemp -d)
qlmanage -t -s 512 tools/icon.svg -o "$TMP" >/dev/null 2>&1
SRC="$TMP/icon.svg.png"
[ -f "$SRC" ] || { echo "QuickLook render failed" >&2; exit 1; }
mkdir -p icons
for size in 16 32 48 128; do
  sips -z "$size" "$size" "$SRC" --out "icons/icon${size}.png" >/dev/null
  echo "wrote icons/icon${size}.png"
done
rm -rf "$TMP"
