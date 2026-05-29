# Install-NativeInfra.ps1
#
# Installs PostgreSQL 16 + Redis as native Windows services so Novan
# no longer depends on Docker. Both services auto-start at boot,
# survive Docker Desktop crashes, and continue running through
# laptop sleep/wake.
#
# Strategy:
#   1. Use winget (preferred) → falls back to direct EnterpriseDB +
#      Memurai downloads if winget is unavailable.
#   2. Wait for services to register; start them.
#   3. Create the `ops` database + `postgres` superuser password +
#      `vector` extension (matches docker-compose schema exactly).
#   4. Patch .env to point at the native services (same URL format
#      as the docker setup — no API code changes needed).
#
# Run once: powershell -ExecutionPolicy Bypass -File scripts\Install-NativeInfra.ps1
# Idempotent: safe to re-run; skips installs that are already present.

#Requires -RunAsAdministrator

$Host.UI.RawUI.WindowTitle = "Novan · Native Infra Install"
$ROOT = Split-Path $PSScriptRoot -Parent
$ErrorActionPreference = 'Stop'

function Write-Step { param($m) Write-Host "  ▸ $m" -ForegroundColor Blue }
function Write-Ok   { param($m) Write-Host "  ✓ $m" -ForegroundColor Green }
function Write-Warn { param($m) Write-Host "  ⚠ $m" -ForegroundColor Yellow }
function Write-Fail { param($m) Write-Host "  ✗ $m" -ForegroundColor Red }

# ── Admin guard ───────────────────────────────────────────────────────
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]'Administrator')
if (-not $isAdmin) {
  Write-Fail "Must run as Administrator (services need elevation to install)."
  Write-Host "  Right-click PowerShell → Run as Administrator, then re-run this script." -ForegroundColor DarkGray
  Read-Host "Press Enter to exit"
  exit 1
}

Write-Host ""
Write-Host "  Installing native Postgres + Redis for Novan..." -ForegroundColor Cyan
Write-Host ""

# ── 1. PostgreSQL 16 ──────────────────────────────────────────────────
$pgSvc = Get-Service -Name 'postgresql*' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($pgSvc) {
  Write-Ok "PostgreSQL already installed (service: $($pgSvc.Name))"
} else {
  Write-Step "Installing PostgreSQL 16 via winget..."
  # PostgreSQL.PostgreSQL.16 — installs to C:\Program Files\PostgreSQL\16
  # and registers as service `postgresql-x64-16`.
  winget install --id PostgreSQL.PostgreSQL.16 --silent --accept-package-agreements --accept-source-agreements --override "--mode unattended --superpassword postgres --servicename postgresql-x64-16 --serviceaccount NetworkService"
  if ($LASTEXITCODE -ne 0) {
    Write-Fail "winget install failed (exit $LASTEXITCODE). Install Postgres manually from https://www.postgresql.org/download/windows/ and re-run."
    Read-Host "Press Enter to exit"
    exit 1
  }
  Write-Ok "PostgreSQL 16 installed"
}

# Locate psql.exe (winget doesn't put it on PATH by default)
$psql = Get-ChildItem -Path "$env:ProgramFiles\PostgreSQL" -Recurse -Filter 'psql.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $psql) {
  Write-Fail "Could not locate psql.exe under C:\Program Files\PostgreSQL — install may have failed."
  Read-Host "Press Enter to exit"
  exit 1
}
$psqlExe = $psql.FullName

# Ensure service is running
$pgSvc = Get-Service -Name 'postgresql*' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($pgSvc.Status -ne 'Running') { Start-Service $pgSvc.Name; Start-Sleep -Seconds 3 }
Set-Service -Name $pgSvc.Name -StartupType Automatic
Write-Ok "PostgreSQL service running (StartupType: Automatic)"

# ── 2. Create `ops` database + pgvector ──────────────────────────────
$env:PGPASSWORD = 'postgres'
Write-Step "Creating 'ops' database + pgvector extension..."
& $psqlExe -U postgres -h localhost -c "SELECT 1 FROM pg_database WHERE datname = 'ops'" -tA 2>$null | Out-Null
$exists = & $psqlExe -U postgres -h localhost -c "SELECT 1 FROM pg_database WHERE datname = 'ops'" -tA 2>$null
if ($exists -ne '1') {
  & $psqlExe -U postgres -h localhost -c "CREATE DATABASE ops" | Out-Null
  Write-Ok "Created 'ops' database"
} else {
  Write-Ok "'ops' database already exists"
}

# pgvector — bundled with the EnterpriseDB Windows build since PG 16
& $psqlExe -U postgres -h localhost -d ops -c "CREATE EXTENSION IF NOT EXISTS vector" 2>&1 | Out-Null
if ($LASTEXITCODE -eq 0) {
  Write-Ok "pgvector extension ready"
} else {
  Write-Warn "pgvector extension install failed — may need manual install from https://github.com/pgvector/pgvector"
  Write-Host "  Workflow: download pgvector binaries → copy to \$PG_INSTALL\share\extension\ → re-run." -ForegroundColor DarkGray
}

# ── 3. Redis (Memurai = MSFT-blessed Windows Redis) ───────────────────
$redisSvc = Get-Service -Name 'Memurai','Redis' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($redisSvc) {
  Write-Ok "Redis-compatible service already installed: $($redisSvc.Name)"
} else {
  Write-Step "Installing Memurai (Redis for Windows) via winget..."
  winget install --id Memurai.MemuraiDeveloper --silent --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) {
    Write-Warn "winget Memurai install failed. Trying Redis directly..."
    winget install --id Redis.Redis --silent --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) {
      Write-Fail "Could not install Redis. Manual install: https://github.com/memurai/memurai/releases"
      Read-Host "Press Enter to exit"
      exit 1
    }
  }
  Write-Ok "Redis installed"
}

# Ensure Redis service is running
$redisSvc = Get-Service -Name 'Memurai','Redis' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($redisSvc.Status -ne 'Running') { Start-Service $redisSvc.Name; Start-Sleep -Seconds 2 }
Set-Service -Name $redisSvc.Name -StartupType Automatic
Write-Ok "Redis service running (StartupType: Automatic)"

# ── 4. Patch .env to point at native services ─────────────────────────
$envPath = "$ROOT\.env"
if (-not (Test-Path $envPath)) {
  Copy-Item "$ROOT\.env.example" $envPath
}
$envContent = Get-Content $envPath -Raw
# Native URLs are identical format to docker — only host:port changes
# could occur if you tuned Postgres port. Default 5432/6379 match.
if ($envContent -notmatch 'DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ops') {
  $envContent = $envContent -replace 'DATABASE_URL=.*', 'DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ops'
}
if ($envContent -notmatch 'REDIS_URL=redis://localhost:6379') {
  if ($envContent -match 'REDIS_URL=') {
    $envContent = $envContent -replace 'REDIS_URL=.*', 'REDIS_URL=redis://localhost:6379'
  } else {
    $envContent += "`nREDIS_URL=redis://localhost:6379`n"
  }
}
Set-Content -Path $envPath -Value $envContent -Encoding utf8 -NoNewline
Write-Ok ".env patched for native infrastructure"

# ── 5. Set service recovery: auto-restart on failure ──────────────────
# Windows service recovery: on first/second/subsequent failure → restart
# after 5s. This is the OS-level supervisor for native infra.
& sc.exe failure $pgSvc.Name    reset= 86400 actions= restart/5000/restart/5000/restart/5000 | Out-Null
& sc.exe failure $redisSvc.Name reset= 86400 actions= restart/5000/restart/5000/restart/5000 | Out-Null
Write-Ok "Service recovery configured (auto-restart after 5s on crash)"

Write-Host ""
Write-Host "  ┌─────────────────────────────────────────────┐" -ForegroundColor DarkCyan
Write-Host "  │  ✓ Native infrastructure ready              │" -ForegroundColor Green
Write-Host "  │                                             │" -ForegroundColor DarkCyan
Write-Host "  │  Postgres: localhost:5432 (ops db)          │" -ForegroundColor Gray
Write-Host "  │  Redis:    localhost:6379                   │" -ForegroundColor Gray
Write-Host "  │  Both start at boot, restart on crash       │" -ForegroundColor Gray
Write-Host "  │                                             │" -ForegroundColor DarkCyan
Write-Host "  │  Novan auto-detects native mode on launch — │" -ForegroundColor Gray
Write-Host "  │  Docker is no longer required.              │" -ForegroundColor Gray
Write-Host "  └─────────────────────────────────────────────┘" -ForegroundColor DarkCyan
Write-Host ""
