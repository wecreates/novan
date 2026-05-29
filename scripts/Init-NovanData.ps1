# Init-NovanData.ps1
#
# Creates the on-disk runtime data tree used by services that need
# durable, device-local storage outside of Postgres. Idempotent —
# safe to re-run.
#
# Layout:
#   novan-data/
#     db/           SQLite or embedded stores (currently unused — reserved
#                   for an eventual single-device mode; see deferred work)
#     logs/         Long-form audit logs that outlive .launch-logs rotation
#     assets/       Generated images, audio, exports
#     memory/       Semantic memory snapshots + embeddings cache
#     checkpoints/  Periodic state snapshots for recovery
#     workspaces/   Per-workspace working files
#     runtime/      Ephemeral runtime artifacts (cron locks, etc.)
#
# What this script does NOT do:
#   - Configure SQLite — the API currently uses Postgres-only features
#     (LISTEN/NOTIFY, jsonb, pgvector). Adding a SQLite fallback is a
#     genuine migration project; the directory is reserved for when
#     that work happens, not pretended-into-existence.
#   - Encrypt files at rest — that's a separate task (KMS, key rotation,
#     unsealing on boot). The directory tree is plain disk for now.

$Host.UI.RawUI.WindowTitle = "Novan · Data Init"
$ROOT = Split-Path $PSScriptRoot -Parent
$DATA = "$ROOT\novan-data"

$dirs = @(
  $DATA,
  "$DATA\db",
  "$DATA\logs",
  "$DATA\assets",
  "$DATA\memory",
  "$DATA\checkpoints",
  "$DATA\workspaces",
  "$DATA\runtime"
)

function Write-Step { param($m) Write-Host "  ▸ $m" -ForegroundColor Blue }
function Write-Ok   { param($m) Write-Host "  ✓ $m" -ForegroundColor Green }

Write-Host ""
Write-Host "  Initializing novan-data/ tree..." -ForegroundColor Cyan

foreach ($d in $dirs) {
  if (-not (Test-Path $d)) {
    New-Item -ItemType Directory -Path $d -Force | Out-Null
    Write-Step "Created $($d.Substring($ROOT.Length + 1))"
  } else {
    Write-Ok "Exists  $($d.Substring($ROOT.Length + 1))"
  }
}

# Drop a README so the purpose of each subdir is self-documenting.
$readme = @'
# novan-data

Device-local runtime data. Survives Docker/Postgres restarts.

| Folder        | Purpose                                              |
|---------------|------------------------------------------------------|
| db/           | Reserved for SQLite fallback (not yet wired)         |
| logs/         | Long-form audit logs                                 |
| assets/       | Generated images, audio, exports                     |
| memory/       | Semantic memory snapshots + embedding cache          |
| checkpoints/  | Periodic snapshots for recovery                      |
| workspaces/   | Per-workspace working files                          |
| runtime/      | Ephemeral runtime artifacts                          |

Back up with:  scripts\novan.ps1 backup
Restore with:  scripts\novan.ps1 restore <zip>
'@
$readmePath = "$DATA\README.md"
if (-not (Test-Path $readmePath)) {
  Set-Content -Path $readmePath -Value $readme -Encoding utf8
  Write-Ok "Wrote $DATA\README.md"
}

# Add to .gitignore if not already there. Append-only — never rewrites
# existing rules.
$gitignore = "$ROOT\.gitignore"
if (Test-Path $gitignore) {
  $content = Get-Content $gitignore -Raw
  if ($content -notmatch '(?m)^novan-data/') {
    Add-Content -Path $gitignore -Value "`n# Device-local runtime data — never committed`nnovan-data/`nnovan-backups/`n"
    Write-Ok "Added novan-data/ + novan-backups/ to .gitignore"
  }
}

Write-Host ""
Write-Host "  ✓ Done. Use 'novan backup' to snapshot this tree." -ForegroundColor Green
Write-Host ""
