# Configure-CloudInfra.ps1
#
# Points Novan at managed Postgres (Neon) + Redis (Upstash) so the
# laptop only runs Node — no Docker, no native services, no local
# DB to maintain. Survives laptop sleep, reboot, and even being
# turned off for a week (the brain just resumes from where Neon's
# WAL left off).
#
# This script does not provision the accounts (those need a browser
# login + payment method). It accepts the connection strings you
# paste from the Neon + Upstash dashboards, validates them, and
# writes them to .env. The launcher then auto-detects cloud mode.
#
# Run: powershell -ExecutionPolicy Bypass -File scripts\Configure-CloudInfra.ps1

$Host.UI.RawUI.WindowTitle = "Novan · Cloud Infra Setup"
$ROOT = Split-Path $PSScriptRoot -Parent

function Write-Step { param($m) Write-Host "  ▸ $m" -ForegroundColor Blue }
function Write-Ok   { param($m) Write-Host "  ✓ $m" -ForegroundColor Green }
function Write-Warn { param($m) Write-Host "  ⚠ $m" -ForegroundColor Yellow }
function Write-Fail { param($m) Write-Host "  ✗ $m" -ForegroundColor Red }

Write-Host ""
Write-Host "  Configure cloud infrastructure for Novan" -ForegroundColor Cyan
Write-Host "  ────────────────────────────────────────" -ForegroundColor DarkCyan
Write-Host ""
Write-Host "  This points Novan at managed Postgres + Redis so the laptop" -ForegroundColor Gray
Write-Host "  doesn't need Docker or local services. The brain survives" -ForegroundColor Gray
Write-Host "  sleep, reboot, and even shutdown — state lives in the cloud." -ForegroundColor Gray
Write-Host ""
Write-Host "  You'll need a connection string from each:" -ForegroundColor Gray
Write-Host "    • Neon Postgres   → https://console.neon.tech" -ForegroundColor DarkCyan
Write-Host "      (free tier: 0.5 GB storage, plenty for the brain)" -ForegroundColor DarkGray
Write-Host "    • Upstash Redis   → https://console.upstash.com" -ForegroundColor DarkCyan
Write-Host "      (free tier: 256 MB, 10k commands/day)" -ForegroundColor DarkGray
Write-Host ""

# ── 1. Collect DATABASE_URL ──────────────────────────────────────────
Write-Step "Neon Postgres connection string"
Write-Host "  Format: postgresql://USER:PASS@HOST.neon.tech/DBNAME?sslmode=require" -ForegroundColor DarkGray
Write-Host "  (paste from Neon dashboard → Connection Details)" -ForegroundColor DarkGray
$dbUrl = Read-Host "  DATABASE_URL"

if ($dbUrl -notmatch '^postgresql://') {
  Write-Fail "Doesn't look like a Postgres URL (must start with postgresql://)"
  Read-Host "Press Enter to exit"; exit 1
}
if ($dbUrl -match 'localhost|127\.0\.0\.1') {
  Write-Warn "URL points at localhost — that's local, not cloud. Re-run with the Neon URL."
  Read-Host "Press Enter to exit"; exit 1
}
if ($dbUrl -notmatch 'sslmode=require') {
  Write-Warn "No sslmode=require in URL — Neon requires SSL. Adding it."
  $sep = if ($dbUrl -match '\?') { '&' } else { '?' }
  $dbUrl = "$dbUrl$sep" + 'sslmode=require'
}

# ── 2. Collect REDIS_URL ─────────────────────────────────────────────
Write-Host ""
Write-Step "Upstash Redis connection string"
Write-Host "  Format: rediss://default:PASSWORD@HOST.upstash.io:PORT" -ForegroundColor DarkGray
Write-Host "  (paste from Upstash dashboard → 'rediss://' link)" -ForegroundColor DarkGray
$redisUrl = Read-Host "  REDIS_URL"

if ($redisUrl -notmatch '^rediss?://') {
  Write-Fail "Doesn't look like a Redis URL (must start with redis:// or rediss://)"
  Read-Host "Press Enter to exit"; exit 1
}
if ($redisUrl -match 'localhost|127\.0\.0\.1') {
  Write-Warn "URL points at localhost. Re-run with the Upstash URL."
  Read-Host "Press Enter to exit"; exit 1
}

# ── 3. Connectivity probe before writing ─────────────────────────────
Write-Host ""
Write-Step "Probing Neon connectivity..."
$pgHost = ([Uri]$dbUrl).Host
$tcp = Test-NetConnection -ComputerName $pgHost -Port 5432 -InformationLevel Quiet -WarningAction SilentlyContinue
if (-not $tcp) {
  Write-Warn "Could not reach $pgHost`:5432 — check firewall/VPN. Writing config anyway."
} else {
  Write-Ok "$pgHost`:5432 reachable"
}

# Upstash uses port 6379 by default; URL may specify a custom one.
$redisHost = ([Uri]$redisUrl).Host
$redisPort = if (([Uri]$redisUrl).Port -gt 0) { ([Uri]$redisUrl).Port } else { 6379 }
Write-Step "Probing Upstash connectivity..."
$tcp2 = Test-NetConnection -ComputerName $redisHost -Port $redisPort -InformationLevel Quiet -WarningAction SilentlyContinue
if (-not $tcp2) {
  Write-Warn "Could not reach $redisHost`:$redisPort — check firewall. Writing config anyway."
} else {
  Write-Ok "$redisHost`:$redisPort reachable"
}

# ── 4. Backup + patch .env ───────────────────────────────────────────
$envPath = "$ROOT\.env"
if (-not (Test-Path $envPath)) {
  Copy-Item "$ROOT\.env.example" $envPath
}
$backupPath = "$envPath.backup-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
Copy-Item $envPath $backupPath
Write-Ok "Backed up existing .env → $(Split-Path $backupPath -Leaf)"

$envContent = Get-Content $envPath -Raw
if ($envContent -match 'DATABASE_URL=') {
  $envContent = $envContent -replace 'DATABASE_URL=.*', "DATABASE_URL=$dbUrl"
} else {
  $envContent += "`nDATABASE_URL=$dbUrl"
}
if ($envContent -match 'REDIS_URL=') {
  $envContent = $envContent -replace 'REDIS_URL=.*', "REDIS_URL=$redisUrl"
} else {
  $envContent += "`nREDIS_URL=$redisUrl"
}
Set-Content -Path $envPath -Value $envContent -Encoding utf8 -NoNewline
Write-Ok ".env patched for cloud infrastructure"

# ── 5. Schema push to Neon ───────────────────────────────────────────
Write-Host ""
Write-Step "Pushing schema to Neon (drizzle-kit push)..."
Write-Host "  This creates all tables + pgvector extension on the remote DB." -ForegroundColor DarkGray
Push-Location "$ROOT\packages\db"
$env:DATABASE_URL = $dbUrl
& node_modules/.bin/drizzle-kit push 2>&1
$pushExit = $LASTEXITCODE
Pop-Location

if ($pushExit -ne 0) {
  Write-Warn "Schema push exited $pushExit — check the output above. You can retry with:"
  Write-Host "    cd packages\db ; node_modules\.bin\drizzle-kit push" -ForegroundColor DarkGray
} else {
  Write-Ok "Schema applied to Neon"
}

# ── 6. Hint for pgvector on Neon ─────────────────────────────────────
Write-Host ""
Write-Warn "Neon requires you to enable pgvector in the dashboard:"
Write-Host "  1. Open https://console.neon.tech → your project → SQL Editor" -ForegroundColor DarkGray
Write-Host "  2. Run: CREATE EXTENSION IF NOT EXISTS vector;" -ForegroundColor DarkGray
Write-Host "  (one-time setup; the launcher won't try to do this from your laptop)" -ForegroundColor DarkGray

Write-Host ""
Write-Host "  ┌─────────────────────────────────────────────┐" -ForegroundColor DarkCyan
Write-Host "  │  ✓ Cloud infrastructure configured          │" -ForegroundColor Green
Write-Host "  │                                             │" -ForegroundColor DarkCyan
Write-Host "  │  Postgres: Neon (managed)                   │" -ForegroundColor Gray
Write-Host "  │  Redis:    Upstash (managed)                │" -ForegroundColor Gray
Write-Host "  │                                             │" -ForegroundColor DarkCyan
Write-Host "  │  Laptop only runs Node now. No Docker, no   │" -ForegroundColor Gray
Write-Host "  │  local DB. Survives sleep + shutdown.       │" -ForegroundColor Gray
Write-Host "  │                                             │" -ForegroundColor DarkCyan
Write-Host "  │  To revert: copy .env.backup-* over .env    │" -ForegroundColor DarkGray
Write-Host "  └─────────────────────────────────────────────┘" -ForegroundColor DarkCyan
Write-Host ""
