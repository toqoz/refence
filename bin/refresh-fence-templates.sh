#!/usr/bin/env bash
# Refresh docs/fence-templates/*.json from the currently installed fence(1).
# Run this whenever fence ships a template update sence needs to track.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
OUT="$ROOT/docs/fence-templates"

mkdir -p "$OUT"

for t in code code-strict code-relaxed local-dev-server; do
  fence config show -t "$t" | awk '/^{/{flag=1} flag{print}' > "$OUT/$t.json"
  node -e "JSON.parse(require('fs').readFileSync('$OUT/$t.json','utf-8'))"
  echo "refreshed $OUT/$t.json"
done
