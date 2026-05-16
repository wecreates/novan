#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Restore the ops Postgres database from a dump file.
  Usage: ./scripts/db-restore.ps1 -BackupFile backups/ops-backup-20240101-120000.sql
#>
param(
  [Parameter(Mandatory)][string]$BackupFile,
  [switch]$Force
)

$ErrorActionPreference = "Continue"
$ROOT = Split-Path $PSScriptRoot -Parent

if (-not (Test-Path $BackupFile)) { throw "Backup file not found: $BackupFile" }

# Load env
$dbUrl = (Get-Content "$ROOT\.env" | Select-String "DATABASE_URL=") -replace 'DATABASE_URL=','' -replace '"',''
if ($dbUrl -match 'postgresql://([^:]+):([^@]+)@([^:]+):(\d+)/(.+)') {
  $PG_USER = $Matches[1]; $PG_PASS = $Matches[2]; $PG_DB = $Matches[5]
} else { throw "Cannot parse DATABASE_URL" }

if (-not $Force) {
  $confirm = Read-Host "This will OVERWRITE database '$PG_DB'. Type 'yes' to confirm"
  if ($confirm -ne 'yes') { Write-Host "Aborted."; exit 0 }
}

Write-Host "Restoring from: $BackupFile" -ForegroundColor Yellow

# Pre-restore row counts
$preCounts = docker compose -f "$ROOT\docker-compose.yml" exec -T postgres `
  psql -U $PG_USER -d $PG_DB -t -c "SELECT COUNT(*) FROM events;" 2>&1 | Where-Object { $_ -match '^\s*\d' }
Write-Host "Pre-restore events: $($preCounts.Trim())"

# Stream SQL file into psql inside container
$env:PGPASSWORD = $PG_PASS
Get-Content $BackupFile -Raw | docker compose -f "$ROOT\docker-compose.yml" exec -T postgres `
  psql -U $PG_USER -d $PG_DB --set ON_ERROR_STOP=0 -q 2>&1 | Where-Object { $_ -match 'ERROR' } | Select-Object -First 10

if ($LASTEXITCODE -and $LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 3) {
  Write-Host "Restore had non-fatal errors (exit $LASTEXITCODE) — checking row counts" -ForegroundColor Yellow
}

# Post-restore counts
$postCounts = docker compose -f "$ROOT\docker-compose.yml" exec -T postgres `
  psql -U $PG_USER -d $PG_DB -c "
  SELECT
    (SELECT COUNT(*) FROM events) as events,
    (SELECT COUNT(*) FROM workflow_runs) as runs,
    (SELECT COUNT(*) FROM memories) as memories,
    (SELECT COUNT(*) FROM briefings) as briefings,
    (SELECT COUNT(*) FROM workspaces) as workspaces;" 2>&1

Write-Host "Post-restore counts:" -ForegroundColor Cyan
$postCounts | Where-Object { $_ -notmatch '^time=' }

Write-Host "Restore complete." -ForegroundColor Green
