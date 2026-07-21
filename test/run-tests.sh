#!/usr/bin/env bash
# Headless engine tests via gjs (parser / compile / classify are DOM-free).
set -euo pipefail
cd "$(dirname "$0")/.."
TMP=$(mktemp /tmp/plotter-test-XXXX.js)
trap 'rm -f "$TMP"' EXIT
{
  echo 'globalThis.window = globalThis; window.addEventListener = function(){};'
  cat src/parser.js src/compile.js src/classify.js src/geometry.js src/ui.js test/engine-test.js
} > "$TMP"
gjs "$TMP"
