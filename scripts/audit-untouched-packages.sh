#!/usr/bin/env bash
# R146.330 #1-8 — automated audit sweep of packages I've never opened.
# Greps for known-bad patterns; outputs findings as markdown so they can
# be triaged.
set -euo pipefail

ROOT="$(dirname "$0")/.."
OUT="$ROOT/docs/R330-PACKAGE-AUDIT.md"

TARGETS=(
  "packages/runtime-kernel"
  "packages/policy-engine"
  "packages/workflow-engine"
  "packages/provider-router"
  "packages/ai-router"
  "packages/ui-system"
  "apps/admin"
  "apps/windows-bridge"
)

PATTERNS=(
  'eval\('                                'eval() use'
  'new Function\('                        'Function constructor'
  'child_process'                          'child_process import'
  'process\.env\[.*\]!'                    'non-null-asserted env var (R-prone)'
  'workspace_id.*\?\?.*default'           'default-workspace fallback'
  'console\.error'                         'console.error (should be pino)'
  'catch\s*\(\s*\)\s*{\s*}'                'empty catch'
  'new Map<.*>\(\)'                        'unbounded Map'
  'fetch\([^)]*input\.'                    'fetch on user input (SSRF risk)'
  'sql\.unsafe'                            'sql.unsafe escape'
  'innerHTML'                              'innerHTML write (XSS risk)'
)

{
  echo "# R146.330 #1-8 — untouched-package audit findings"
  echo
  echo "Generated $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo
  for tgt in "${TARGETS[@]}"; do
    if [ ! -d "$ROOT/$tgt" ]; then
      echo "## $tgt — NOT PRESENT"
      echo
      continue
    fi
    echo "## $tgt"
    echo
    for ((i=0; i<${#PATTERNS[@]}; i+=2)); do
      pat="${PATTERNS[i]}"
      label="${PATTERNS[i+1]}"
      hits=$(grep -rEn "$pat" "$ROOT/$tgt/src" 2>/dev/null || true)
      if [ -n "$hits" ]; then
        count=$(echo "$hits" | wc -l)
        echo "### $label ($count hits)"
        echo
        echo '```'
        echo "$hits" | head -10
        echo '```'
        echo
      fi
    done
  done
} > "$OUT"

echo "[audit] wrote $OUT"
wc -l "$OUT"
