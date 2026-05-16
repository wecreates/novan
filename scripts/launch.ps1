
# ╔══════════════════════════════════════════════════════════════════════╗
# ║                NOVAN — SYSTEM LAUNCHER                              ║
# ╚══════════════════════════════════════════════════════════════════════╝

$Host.UI.RawUI.WindowTitle = "Novan"
$ErrorActionPreference = "Stop"

$ROOT = Split-Path $PSScriptRoot -Parent

function Write-Header {
  Write-Host ""
  Write-Host "  ███╗   ██╗ ██████╗ ██╗   ██╗ █████╗ ███╗   ██╗" -ForegroundColor White
  Write-Host "  ████╗  ██║██╔═══██╗██║   ██║██╔══██╗████╗  ██║" -ForegroundColor White
  Write-Host "  ██╔██╗ ██║██║   ██║██║   ██║███████║██╔██╗ ██║" -ForegroundColor Gray
  Write-Host "  ██║╚██╗██║██║   ██║╚██╗ ██╔╝██╔══██║██║╚██╗██║" -ForegroundColor Gray
  Write-Host "  ██║ ╚████║╚██████╔╝ ╚████╔╝ ██║  ██║██║ ╚████║" -ForegroundColor DarkGray
  Write-Host "  ╚═╝  ╚═══╝ ╚═════╝   ╚═══╝  ╚═╝  ╚═╝╚═╝  ╚═══╝" -ForegroundColor DarkGray
  Write-Host "  Autonomous Operational Intelligence Platform" -ForegroundColor DarkCyan
  Write-Host ""
}

function Write-Step { param($msg) Write-Host "  ▸ $msg" -ForegroundColor Blue }
function Write-Ok   { param($msg) Write-Host "  ✓ $msg" -ForegroundColor Green }
function Write-Warn { param($msg) Write-Host "  ⚠ $msg" -ForegroundColor Yellow }
function Write-Fail { param($msg) Write-Host "  ✗ $msg" -ForegroundColor Red }

Write-Header

# ── 1. Check Docker ────────────────────────────────────────────────────
Write-Step "Checking Docker..."
try {
  $null = docker info 2>&1
  Write-Ok "Docker is running"
} catch {
  Write-Fail "Docker is not running. Please start Docker Desktop first."
  Read-Host "Press Enter to exit"
  exit 1
}

# ── 2. Start infrastructure ────────────────────────────────────────────
Write-Step "Starting PostgreSQL + Redis..."
Set-Location $ROOT
docker compose up -d postgres redis 2>&1 | Out-Null
Write-Ok "Infrastructure containers started"

# ── 3. Wait for healthy ────────────────────────────────────────────────
Write-Step "Waiting for Postgres to be ready..."
$attempts = 0
do {
  Start-Sleep -Seconds 2
  $attempts++
  $pg = docker compose exec -T postgres pg_isready -U postgres 2>&1
} while ($pg -notmatch "accepting connections" -and $attempts -lt 15)

if ($attempts -ge 15) {
  Write-Warn "Postgres may not be ready — continuing anyway"
} else {
  Write-Ok "PostgreSQL ready"
}

# ── 4. Copy .env if missing ────────────────────────────────────────────
if (-not (Test-Path "$ROOT\.env")) {
  Copy-Item "$ROOT\.env.example" "$ROOT\.env"
  # Fix credential mismatch: .env.example uses ops:ops_secret but docker-compose uses postgres:postgres
  (Get-Content "$ROOT\.env") -replace 'postgresql://ops:ops_secret@localhost:5432/ops_platform','postgresql://postgres:postgres@localhost:5432/ops' | Set-Content "$ROOT\.env"
  Write-Ok "Created .env (with corrected database credentials)"
}

# ── 4b. Enable pgvector ────────────────────────────────────────────────
docker compose exec -T postgres psql -U postgres -d ops -c "CREATE EXTENSION IF NOT EXISTS vector;" 2>&1 | Out-Null
Write-Ok "pgvector extension ready"

# ── 5. Install dependencies ────────────────────────────────────────────
Write-Step "Installing dependencies..."
pnpm install --silent 2>&1 | Out-Null
Write-Ok "Dependencies installed"

# ── 6. Run migrations (schema push) ───────────────────────────────────
Write-Step "Running database schema push..."
try {
  Set-Location "$ROOT\packages\db"
  $env:DATABASE_URL = (Get-Content "$ROOT\.env" | Select-String "DATABASE_URL=" | ForEach-Object { ($_ -split '=', 2)[1].Trim('"') })
  node_modules/.bin/drizzle-kit push 2>&1 | Out-Null
  Write-Ok "Database schema applied"
} catch {
  Write-Warn "Schema push warning: $($_.Exception.Message)"
}
Set-Location $ROOT

# ── 7. Seed data (first run only) ─────────────────────────────────────
$seedMarker = "$ROOT\.seed-complete"
if (-not (Test-Path $seedMarker)) {
  Write-Step "Seeding demo data..."
  try {
    Set-Location "$ROOT\packages\db"
    pnpm db:seed 2>&1 | Out-Null
    Set-Location $ROOT
    New-Item -ItemType File $seedMarker -Force | Out-Null
    Write-Ok "Demo data seeded"
  } catch {
    Write-Warn "Seed warning (non-fatal): $($_.Exception.Message)"
    Set-Location $ROOT
  }
} else {
  Write-Ok "Demo data already seeded"
}

# ── 8. Launch API + Web + Workers in background terminals ─────────────
Write-Step "Starting API server (port 3001)..."
$api = Start-Process powershell -ArgumentList @(
  "-NoExit", "-Command",
  "cd '$ROOT'; `$Host.UI.RawUI.WindowTitle='Ops API'; pnpm --filter @ops/api dev"
) -PassThru -WindowStyle Minimized

Write-Step "Starting Web app (port 3000)..."
$web = Start-Process powershell -ArgumentList @(
  "-NoExit", "-Command",
  "cd '$ROOT'; `$Host.UI.RawUI.WindowTitle='Ops Web'; pnpm --filter @ops/web dev"
) -PassThru -WindowStyle Minimized

Write-Step "Starting background workers..."
$workerNames = @("workflow-worker","analytics-worker","recovery-worker","memory-worker","briefing-worker","optimization-worker")
$workerProcs = @()
foreach ($w in $workerNames) {
  $workerProcs += Start-Process powershell -ArgumentList @(
    "-NoExit", "-Command",
    "cd '$ROOT'; `$Host.UI.RawUI.WindowTitle='Ops Worker: $w'; pnpm --filter @ops/$w dev"
  ) -PassThru -WindowStyle Minimized
}
Write-Ok "$($workerNames.Count) workers started"

# ── 9. Wait for web to be ready then open browser ─────────────────────
Write-Step "Waiting for services to start..."
Start-Sleep -Seconds 5

$ready = $false
for ($i = 0; $i -lt 24; $i++) {
  try {
    $r = Invoke-WebRequest -Uri "http://localhost:3000" -TimeoutSec 2 -UseBasicParsing 2>&1
    if ($r.StatusCode -eq 200) { $ready = $true; break }
  } catch {}
  Start-Sleep -Seconds 2
  Write-Host "    waiting..." -ForegroundColor DarkGray
}

# ── 10. Open browser ──────────────────────────────────────────────────
Write-Host ""
if ($ready) {
  Write-Ok "System ready!"
} else {
  Write-Warn "Services may still be starting..."
}

Write-Host ""
Write-Host "  ┌─────────────────────────────────────────┐" -ForegroundColor DarkCyan
Write-Host "  │  War Room   →  http://localhost:3000     │" -ForegroundColor Cyan
Write-Host "  │  API Docs   →  http://localhost:3001/docs│" -ForegroundColor Cyan
Write-Host "  │  Metrics    →  http://localhost:3001/metrics │" -ForegroundColor Cyan
Write-Host "  └─────────────────────────────────────────┘" -ForegroundColor DarkCyan
Write-Host ""

Start-Process "http://localhost:3000/war-room"

Write-Host "  Press Enter to stop all services and exit..." -ForegroundColor DarkGray
Read-Host

# ── Shutdown ──────────────────────────────────────────────────────────
Write-Host ""
Write-Step "Shutting down..."
Stop-Process -Id $api.Id -Force -ErrorAction SilentlyContinue
Stop-Process -Id $web.Id -Force -ErrorAction SilentlyContinue
foreach ($wp in $workerProcs) {
  Stop-Process -Id $wp.Id -Force -ErrorAction SilentlyContinue
}
docker compose stop postgres redis 2>&1 | Out-Null
Write-Ok "All services stopped. Goodbye."
Start-Sleep -Seconds 1
