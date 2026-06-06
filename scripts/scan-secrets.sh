#!/usr/bin/env bash
# R146.330 #38 — secret scanner. Greps repo + git log for common patterns.
set -euo pipefail
cd "$(dirname "$0")/.."
HITS=0
PATTERNS=(
  'sk-[a-zA-Z0-9]{40,}'              'OpenAI key'
  'sk-ant-[a-zA-Z0-9]{40,}'          'Anthropic key'
  'AIza[a-zA-Z0-9_-]{35}'            'Google API key'
  'xox[bp]-[a-zA-Z0-9-]{40,}'        'Slack token'
  'gho_[a-zA-Z0-9]{36}'              'GitHub PAT'
  'AKIA[0-9A-Z]{16}'                 'AWS key id'
  '-----BEGIN .*PRIVATE KEY-----'    'Private key block'
)
for ((i=0; i<${#PATTERNS[@]}; i+=2)); do
  pat="${PATTERNS[i]}"; label="${PATTERNS[i+1]}"
  found=$(git grep -E "$pat" -- ':!**/*.example' ':!**/*.test.ts' ':!docs/**' 2>/dev/null || true)
  if [ -n "$found" ]; then echo "[secret-scan] $label"; echo "$found"; HITS=1; fi
done
if [ "$HITS" -ne 0 ]; then echo "[secret-scan] FAILED — investigate above"; exit 1; fi
echo "[secret-scan] ok — no obvious secrets in tracked files"
