#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Backup the ops Postgres database to a timestamped dump file.
  Usage: ./scripts/db-backup.ps1 [-OutputDir backups] [-Label "pre-migration"]
#>
param(
  [string]$OutputDir = "backups",
  [string]$Label     = ""
)

$ErrorActionPreference = "Stop"
$ROOT = Split-Path $PSScriptRoot -Parent

# Load DATABASE_URL from .env
$envFile = "$ROOT\.env"
if (-not (Test-Path $envFile)) { throw ".env not found at $envFile" }
$dbUrl = (Get-Content $envFile | Select-String "DATABASE_URL=") -replace 'DATABASE_URL=','' -replace '"',''

# Parse connection string: postgresql://user:pass@host:port/db
if ($dbUrl -match 'postgresql://([^:]+):([^@]+)@([^:]+):(\d+)/(.+)') {
  $PG_USER = $Matches[1]; $PG_PASS = $Matches[2]
  $PG_HOST = $Matches[3]; $PG_PORT = $Matches[4]; $PG_DB   = $Matches[5]
} else {
  throw "Cannot parse DATABASE_URL: $dbUrl"
}

# Ensure output dir exists
$outPath = "$ROOT\$OutputDir"
if (-not (Test-Path $outPath)) { New-Item -ItemType Directory -Path $outPath -Force | Out-Null }

# Timestamp + label
$ts    = Get-Date -Format "yyyyMMdd-HHmmss"
$slug  = if ($Label) { "-$($Label -replace '[^a-zA-Z0-9_-]','')" } else { "" }
$file  = "$outPath\ops-backup-$ts$slug.sql"

Write-Host "Backing up ops database to: $file" -ForegroundColor Cyan

# Run pg_dump inside Postgres container
$env:PGPASSWORD = $PG_PASS
docker compose -f "$ROOT\docker-compose.yml" exec -T postgres `
  pg_dump -U $PG_USER -d $PG_DB --no-owner --no-acl --clean --if-exists | Out-File -FilePath $file -Encoding utf8

if ($LASTEXITCODE -ne 0) { throw "pg_dump failed (exit $LASTEXITCODE)" }

$size = (Get-Item $file).Length
Write-Host "Backup complete: $file ($([math]::Round($size/1KB, 1)) KB)" -ForegroundColor Green

# Write metadata sidecar
@{
  timestamp  = $ts
  label      = $Label
  file       = $file
  size_bytes = $size
  database   = $PG_DB
  host       = $PG_HOST
} | ConvertTo-Json | Out-File "$file.meta.json" -Encoding utf8

Write-Output $file
