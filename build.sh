#!/usr/bin/env bash
# Assembles the self-contained offline index.html from deps/ and src/.
set -euo pipefail
cd "$(dirname "$0")"

OUT=index.html

{
  cat <<'EOF'
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Plotter 3D</title>
<style>
EOF
  # mathquill css, minus the @font-face block (offline: no font files)
  sed '/@font-face {/,/^}/d' deps/mathquill.css
  cat src/style.css
  cat <<'EOF'
</style>
</head>
<body>
EOF
  cat src/body.html
  for f in deps/jquery.min.js deps/mathquill.min.js deps/three.min.js deps/OrbitControls.js \
           src/parser.js src/compile.js src/classify.js src/geometry.js src/scene.js src/ui.js src/main.js; do
    echo "<script>"
    cat "$f"
    echo "</script>"
  done
  cat <<'EOF'
</body>
</html>
EOF
} > "$OUT"

echo "built $OUT ($(du -h "$OUT" | cut -f1))"
