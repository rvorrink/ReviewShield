#!/bin/sh
# Builds dist/reviewshield-<version>.zip for Chrome Web Store upload.
# Contains only the runtime files the extension needs; dist/ is gitignored.
# Run from anywhere: sh tools/package.sh
set -e
cd "$(dirname "$0")/.."
VERSION=$(node -e "console.log(JSON.parse(require('fs').readFileSync('manifest.json','utf8')).version)")
mkdir -p dist
OUT="dist/reviewshield-$VERSION.zip"
rm -f "$OUT"
zip -r "$OUT" manifest.json _locales content icons lib popup -x '*.DS_Store' >/dev/null
echo "wrote $OUT"
unzip -l "$OUT" | tail -2
