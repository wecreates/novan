
# ╔══════════════════════════════════════════════════════════════════════╗
# ║                NOVAN — SYSTEM LAUNCHER                              ║
# ╚══════════════════════════════════════════════════════════════════════╝

$Host.UI.RawUI.WindowTitle = "Novan"
# PowerShell 5.1 quirk: with ErrorActionPreference=Stop AND `2>&1`,
# *every* line a native command writes to stderr is wrapped as a
# NativeCommandError and terminates the script — even benign warnings
# like docker's "the attribute 'version' is obsolete". The launcher was
# silently dying on the first docker warning. Use Continue + explicit
# exit-code checks instead.
$ErrorActionPreference = "Continue"

# Capture transcript so even a silent crash leaves a paper trail.
$ROOT = Split-Path $PSScriptRoot -Parent
$logDir = Join-Path $ROOT ".launch-logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$logFile = Join-Path $logDir ("launch-{0}.log" -f (Get-Date -Format "yyyyMMdd-HHmmss"))
try { Start-Transcript -Path $logFile -Force | Out-Null } catch {}

# Fail-loud trap: if anything throws and we'd otherwise close the window
# silently, print where + why + the full stack and wait for Enter before
# exiting. This is what was hiding the actual crash.
trap {
  Write-Host ""
  Write-Host "  ════════════════════════════════════════════" -ForegroundColor Red
  Write-Host "  ✗ NOVAN LAUNCH FAILED" -ForegroundColor Red
  Write-Host "  ════════════════════════════════════════════" -ForegroundColor Red
  Write-Host "  Error:    $($_.Exception.Message)" -ForegroundColor Yellow
  Write-Host "  At:       $($_.InvocationInfo.PositionMessage)" -ForegroundColor DarkYellow
  Write-Host "  Log file: $logFile" -ForegroundColor DarkGray
  Write-Host ""
  Write-Host "  Stack:" -ForegroundColor DarkGray
  Write-Host "  $($_.ScriptStackTrace)" -ForegroundColor DarkGray
  Write-Host ""
  Read-Host "  Press Enter to close"
  try { Stop-Transcript | Out-Null } catch {}
  exit 1
}

function Write-Header {
  Write-Host ""
  Write-Host "  ███╗   ██╗ ██████╗ ██╗   ██╗ █████╗ ███╗   ██╗" -ForegroundColor White
  Write-Host "  ████╗  ██║██╔═══██╗██║   ██║██╔══██╗████╗  ██║" -ForegroundColor White
  Write-Host "  ██╔██╗ ██║██║   ██║██║   ██║███████║██╔██╗ ██║" -ForegroundColor Gray
  Write-Host "  ██║╚██╗██║██║   ██║╚██╗ ██╔╝██╔══██║██║╚██╗██║" -ForegroundColor Gray
  Write-Host "  ██║ ╚████║╚██████╔╝ ╚████╔╝ ██║  ██║██║ ╚████║" -ForegroundColor DarkGray
  Write-Host "  ╚═╝  ╚═══╝ ╚═════╝   ╚═══╝  ╚═╝  ╚═╝╚═╝  ╚═══╝" -ForegroundColor DarkGray
  Write-Host "  Autonomous Operational Intelligence Platform" -ForegroundColor DarkCyan
}

# ── Instant-start hot path ───────────────────────────────────────────
# If API + web are already responding, skip ALL boot work and open
# the browser immediately. Typical hit: under 400ms. Only falls through
# to full boot when services are actually down.
function Test-NovanAlive {
  $api = $null; $web = $null
  try { $api = Invoke-WebRequest -Uri "http://localhost:3001/health" -TimeoutSec 1 -UseBasicParsing -ErrorAction SilentlyContinue } catch {}
  try { $web = Invoke-WebRequest -Uri "http://localhost:3000"       -TimeoutSec 1 -UseBasicParsing -ErrorAction SilentlyContinue } catch {}
  return ($api -and $api.StatusCode -eq 200 -and $web -and $web.StatusCode -eq 200)
}
if (Test-NovanAlive) {
  Start-Process "http://localhost:3000/brain"
  # Hide the console flash
  $sig = '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);'
  try { $u = Add-Type -MemberDefinition $sig -Name 'W' -Namespace 'N' -PassThru -ErrorAction SilentlyContinue; if ($u) { $u::ShowWindow((Get-Process -Id $PID).MainWindowHandle, 0) } } catch {}
  try { Stop-Transcript | Out-Null } catch {}
  exit 0
}

function Write-Step { param($msg) Write-Host "  ▸ $msg" -ForegroundColor Blue }
function Write-Ok   { param($msg) Write-Host "  ✓ $msg" -ForegroundColor Green }
function Write-Warn { param($msg) Write-Host "  ⚠ $msg" -ForegroundColor Yellow }
function Write-Fail { param($msg) Write-Host "  ✗ $msg" -ForegroundColor Red }

# Win32 interop so we can hide our own console window after the browser
# opens. The launcher process stays alive (so children stay tracked +
# Ctrl-C cleanup still fires) — only the visible window disappears.
if (-not ([System.Management.Automation.PSTypeName]'NovanWin32').Type) {
  Add-Type -Namespace NovanWin32 -Name Native -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll")]
public static extern System.IntPtr GetConsoleWindow();
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);
[System.Runtime.InteropServices.DllImport("kernel32.dll")]
public static extern uint SetThreadExecutionState(uint esFlags);
'@
}
function Hide-ConsoleWindow {
  $h = [NovanWin32.Native]::GetConsoleWindow()
  if ($h -ne [IntPtr]::Zero) { [void][NovanWin32.Native]::ShowWindow($h, 0) }  # SW_HIDE
}
function Show-ConsoleWindow {
  $h = [NovanWin32.Native]::GetConsoleWindow()
  if ($h -ne [IntPtr]::Zero) { [void][NovanWin32.Native]::ShowWindow($h, 5) }  # SW_SHOW
}
# Keep Windows awake while the brain is running. The combination tells
# the OS we're doing work (ES_SYSTEM_REQUIRED) on a continuous basis
# (ES_CONTINUOUS). Without this, the laptop's sleep timer suspends the
# whole process tree — including all 36 cron jobs — and "24/7" becomes
# "whenever the lid is open + active". The display can still sleep.
#   ES_CONTINUOUS       = 0x80000000
#   ES_SYSTEM_REQUIRED  = 0x00000001
function Stay-Awake {
  [void][NovanWin32.Native]::SetThreadExecutionState([uint32]'0x80000001')
}
function Release-Awake {
  [void][NovanWin32.Native]::SetThreadExecutionState([uint32]'0x80000000')   # ES_CONTINUOUS only — clears prior flags
}

# ── Build-cache helpers — skip slow steps when nothing changed ───────
# Each "phase" has a cache file under .launch-logs/. We compare the
# tracked inputs against the cached fingerprint and skip the work when
# they match. Idempotent + safe to delete the cache to force a redo.
$cacheDir = $logDir
function Get-FingerprintFile { param($name) Join-Path $cacheDir ".cache-$name" }
function Read-Fingerprint { param($name)
  $f = Get-FingerprintFile $name
  if (Test-Path $f) { (Get-Content $f -Raw -ErrorAction SilentlyContinue).Trim() } else { $null }
}
function Write-Fingerprint { param($name, $value)
  Set-Content -Path (Get-FingerprintFile $name) -Value $value -NoNewline -Encoding utf8
}
function FileSha { param($path)
  if (-not (Test-Path $path)) { return "" }
  (Get-FileHash -Path $path -Algorithm SHA256).Hash
}

Write-Header

# ── 1. Copy .env if missing (mode detection needs it) ─────────────────
if (-not (Test-Path "$ROOT\.env")) {
  Copy-Item "$ROOT\.env.example" "$ROOT\.env"
  (Get-Content "$ROOT\.env") -replace 'postgresql://ops:ops_secret@localhost:5432/ops_platform','postgresql://postgres:postgres@localhost:5432/ops' | Set-Content "$ROOT\.env"
  Write-Ok "Created .env (with corrected database credentials)"
}

# ── 2. Infrastructure mode detection ──────────────────────────────────
# Three modes:
#   CLOUD   — DATABASE_URL points to a remote host (e.g. Neon, Upstash).
#             Skip ALL local infra setup. Most reliable for 24/7.
#   NATIVE  — Postgres + Redis installed as Windows services. No Docker
#             dependency. Survives Docker Desktop crashes + WSL hiccups.
#   DOCKER  — Default. Docker Desktop runs postgres + redis containers.
#             Convenient but adds Docker as a failure surface.
# Mode can be forced via $env:NOVAN_INFRA_MODE; otherwise auto-detected.
function Get-EnvVar { param([string]$Name)
  $line = Get-Content "$ROOT\.env" -ErrorAction SilentlyContinue | Select-String "^$Name="
  if (-not $line) { return $null }
  return ($line.Line -split '=', 2)[1].Trim('"').Trim()
}

$dbUrl    = Get-EnvVar 'DATABASE_URL'
$redisUrl = Get-EnvVar 'REDIS_URL'
$infraMode = $env:NOVAN_INFRA_MODE

if (-not $infraMode) {
  $dbRemote    = $dbUrl    -and ($dbUrl    -notmatch 'localhost|127\.0\.0\.1')
  $redisRemote = $redisUrl -and ($redisUrl -notmatch 'localhost|127\.0\.0\.1')
  if ($dbRemote -and $redisRemote) {
    $infraMode = 'cloud'
  } else {
    # Native = both postgres + redis services exist (any state)
    $pgSvc    = Get-Service -Name 'postgresql*' -ErrorAction SilentlyContinue | Select-Object -First 1
    $redisSvc = Get-Service -Name 'Redis*'     -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($pgSvc -and $redisSvc) { $infraMode = 'native' } else { $infraMode = 'docker' }
  }
}

Write-Step "Infrastructure mode: $infraMode"
Set-Location $ROOT

# ── 3. Bring up infrastructure per mode ───────────────────────────────
# Docker stderr is noisy ("DOCKER_INSECURE_NO_IPTABLES_RAW", deprecation
# warnings, etc). PS5.1 wraps each native-command stderr line as a
# NativeCommandError that floods the transcript even though
# ErrorActionPreference=Continue prevents script death. cmd.exe handles
# the redirection AT the OS handle level before PS sees anything.
$env:DOCKER_CLI_HINTS = "false"     # silence docker's own CLI hints

function Invoke-DockerSilent {
  param([string]$DockerArgs)
  # cmd /c wraps so stderr is discarded at the Windows handle layer
  cmd /c "docker $DockerArgs >nul 2>&1"
  return $LASTEXITCODE
}
function Invoke-DockerCapture {
  param([string]$DockerArgs)
  # Returns stdout only; stderr discarded at cmd-level
  return cmd /c "docker $DockerArgs 2>nul"
}

function Test-Docker-Healthy {
  Invoke-DockerSilent 'info' | Out-Null
  return ($LASTEXITCODE -eq 0)
}

function Start-Docker-Desktop {
  $dockerExe = @(
    "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe",
    "${env:ProgramFiles(x86)}\Docker\Docker\Docker Desktop.exe",
    "$env:LOCALAPPDATA\Docker\Docker Desktop.exe"
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $dockerExe) { return $false }
  Start-Process -FilePath $dockerExe -WindowStyle Hidden | Out-Null
  $waited = 0
  while ($waited -lt 90) {
    Start-Sleep -Seconds 1
    $waited++
    if (Test-Docker-Healthy) { return $true }
  }
  return $false
}

function Start-Native-Infra {
  # Idempotent: Start-Service no-ops if already Running.
  $pg    = Get-Service -Name 'postgresql*' -ErrorAction SilentlyContinue | Select-Object -First 1
  $redis = Get-Service -Name 'Redis*'     -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($pg    -and $pg.Status    -ne 'Running') { Start-Service $pg.Name }
  if ($redis -and $redis.Status -ne 'Running') { Start-Service $redis.Name }
}

$infraRunning = $false   # only meaningful in docker mode (skip cold-start steps)

switch ($infraMode) {
  'cloud' {
    Write-Ok "Cloud infra — Postgres + Redis are remote; nothing to start locally"
    $infraRunning = $true   # skip pgvector / readiness wait — managed providers handle it
  }
  'native' {
    Write-Step "Starting native Postgres + Redis Windows services..."
    Start-Native-Infra
    # Quick readiness probe — services advertise Running before TCP listens
    $attempts = 0
    do { Start-Sleep -Milliseconds 500; $attempts++ } while ($attempts -lt 20 -and -not (Test-NetConnection -ComputerName localhost -Port 5432 -InformationLevel Quiet -WarningAction SilentlyContinue))
    Write-Ok "Native Postgres + Redis ready"
    $infraRunning = $true   # native pgvector handled by Install-NativeInfra.ps1
  }
  'docker' {
    Write-Step "Checking Docker..."
    if (-not (Test-Docker-Healthy)) {
      Write-Warn "Docker engine down — starting Docker Desktop..."
      if (-not (Start-Docker-Desktop)) {
        Write-Fail "Docker Desktop unavailable. Run scripts\Install-NativeInfra.ps1 for a Docker-free setup."
        Read-Host "Press Enter to exit"
        exit 1
      }
      Write-Ok "Docker Desktop started"
    } else {
      Write-Ok "Docker is running"
    }

    $running = Invoke-DockerCapture 'compose ps --services --filter status=running'
    if ($running -match 'postgres' -and $running -match 'redis') {
      $infraRunning = $true
      Write-Ok "Containers already running (skipped cold start)"
    } else {
      Write-Step "Starting PostgreSQL + Redis containers..."
      Invoke-DockerSilent 'compose stop api' | Out-Null
      Invoke-DockerSilent 'compose up -d postgres redis' | Out-Null
      Write-Ok "Containers started"
    }

    if (-not $infraRunning) {
      Write-Step "Waiting for Postgres to be ready..."
      $attempts = 0
      do {
        Start-Sleep -Milliseconds 500
        $attempts++
        $pg = Invoke-DockerCapture 'compose exec -T postgres pg_isready -U postgres'
      } while ($pg -notmatch "accepting connections" -and $attempts -lt 40)
      if ($attempts -ge 40) { Write-Warn "Postgres may not be ready — continuing anyway" }
      else { Write-Ok "PostgreSQL ready" }
      Invoke-DockerSilent 'compose exec -T postgres psql -U postgres -d ops -c "CREATE EXTENSION IF NOT EXISTS vector;"' | Out-Null
      Write-Ok "pgvector extension ready"
    }
  }
}

# ── 5. Install dependencies (cached on lockfile mtime) ────────────────
# Skipped when pnpm-lock.yaml hasn't changed since last successful run.
# Saves ~3 s warm / ~30 s cold first time.
$lockSha   = FileSha "$ROOT\pnpm-lock.yaml"
$cachedLock = Read-Fingerprint 'pnpm-install'
if ($lockSha -eq $cachedLock -and (Test-Path "$ROOT\node_modules")) {
  Write-Ok "Dependencies up to date (cached)"
} else {
Write-Step "Installing dependencies..."
$pnpmOut = pnpm install --silent 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Fail "pnpm install failed with exit $LASTEXITCODE"
  Write-Host $pnpmOut -ForegroundColor DarkGray
  Read-Host "Press Enter to exit"
  try { Stop-Transcript | Out-Null } catch {}
  exit 1
}
Write-Ok "Dependencies installed"
Write-Fingerprint 'pnpm-install' $lockSha
} # end pnpm-install else branch

# ── 6. Run migrations (schema push, cached on schema.ts hash) ─────────
# drizzle-kit push is idempotent but slow (3–8 s). Cache the schema's
# SHA256 and skip when the file hasn't changed. Forcing a re-run is as
# simple as deleting .launch-logs/.cache-schema-push.
$schemaSha   = FileSha "$ROOT\packages\db\src\schema.ts"
$cachedSchema = Read-Fingerprint 'schema-push'
if ($schemaSha -eq $cachedSchema -and $infraRunning) {
  Write-Ok "Database schema up to date (cached)"
} else {
Write-Step "Running database schema push..."
try {
  Set-Location "$ROOT\packages\db"
  $env:DATABASE_URL = (Get-Content "$ROOT\.env" | Select-String "DATABASE_URL=" | ForEach-Object { ($_ -split '=', 2)[1].Trim('"') })
  # drizzle-kit push is interactive — it prompts on schema drift and hangs
  # forever when stdin isn't a TTY (which it isn't under Start-Process).
  # --force auto-confirms; pipe "y" as a belt-and-suspenders fallback for
  # any prompt that ignores --force. Without this the launcher silently
  # hangs at "Running database schema push…" indefinitely.
  $pushOut = "y`ny`ny`n" | & node_modules/.bin/drizzle-kit push --force 2>&1
  if ($LASTEXITCODE -ne 0) {
    Write-Warn "drizzle-kit push exit $LASTEXITCODE — schema may be out of sync"
    Write-Host $pushOut -ForegroundColor DarkGray
  } else {
    Write-Ok "Database schema applied"
    Write-Fingerprint 'schema-push' $schemaSha
  }
} catch {
  Write-Warn "Schema push warning: $($_.Exception.Message)"
}
Set-Location $ROOT
}

# ── 7. Seed data (first run only) ─────────────────────────────────────
$seedMarker = "$ROOT\.seed-complete"
if (-not (Test-Path $seedMarker)) {
  Write-Step "Seeding demo data..."
  try {
    Set-Location "$ROOT\packages\db"
    pnpm db:seed *> $null
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

# ── 8. Launch API + Web + Workers — hidden, no popup windows ──────────
# Operator asked for zero popups. We use:
#   - WindowStyle Hidden    → no console flash on spawn
#   - CreateNoWindow on the inner pnpm process (suppresses the child too)
#   - Stdout + stderr redirected to per-service log files under
#     .launch-logs/ so debugging never requires a visible terminal.
# `pnpm dev` returns a watcher that runs until killed; we keep the
# returned process handles so the shutdown block can terminate them.

$svcLogDir = Join-Path $ROOT ".launch-logs"
if (-not (Test-Path $svcLogDir)) { New-Item -ItemType Directory -Path $svcLogDir | Out-Null }

function Start-HiddenService {
  param([string]$Name, [string]$PnpmFilter)
  $out = Join-Path $svcLogDir "$Name.log"
  $err = Join-Path $svcLogDir "$Name.err.log"
  # `pnpm.cmd` is the resolvable Windows shim; -WindowStyle Hidden plus
  # the cmd shim avoids creating a console window at all. Output is
  # captured to log files for `tail` / Notepad inspection.
  return Start-Process -FilePath "pnpm.cmd" `
    -ArgumentList @("--filter", "@ops/$PnpmFilter", "dev") `
    -WorkingDirectory $ROOT `
    -WindowStyle Hidden `
    -RedirectStandardOutput $out `
    -RedirectStandardError $err `
    -PassThru
}

Write-Step "Starting API server (port 3001)..."
$api = Start-HiddenService -Name "api" -PnpmFilter "api"

Write-Step "Starting Web app (port 3000)..."
$web = Start-HiddenService -Name "web" -PnpmFilter "web"

Write-Step "Starting background workers..."
$workerNames = @("workflow-worker","analytics-worker","recovery-worker","memory-worker","briefing-worker","optimization-worker")
$workerProcs = @()
foreach ($w in $workerNames) {
  $workerProcs += Start-HiddenService -Name $w -PnpmFilter $w
}
Write-Ok "$($workerNames.Count) workers started (logs: .launch-logs\)"

# ── 9. Open browser eagerly + hide console ────────────────────────────
# Two-stage launch:
#   1. Tight 8-second probe loop with 200 ms polls. The moment vite
#      responds, open the browser. Cold vite is usually ready in
#      ~700 ms thanks to lazy routes; warm vite is instant.
#   2. If we time out, we STILL open the browser — Vite shows its own
#      "starting…" indicator + we have refetch-on-reconnect wired so
#      the UI heals as the API finishes booting. This is the perceived-
#      speed unlock: the operator sees the browser ~1 s after click.
#   3. Hide the PowerShell window the instant the browser opens so the
#      operator never sees the launcher again. The script keeps running
#      (invisibly) to track child PIDs for clean shutdown — kill the
#      whole tree with `scripts\Stop-Novan.ps1` or Task Manager.

Write-Step "Waiting for web (max 8 s)..."
$ready = $false
for ($i = 0; $i -lt 40; $i++) {  # 40 * 200ms = 8s max
  try {
    $r = Invoke-WebRequest -Uri "http://localhost:3000" -TimeoutSec 1 -UseBasicParsing -ErrorAction Stop
    if ($r.StatusCode -eq 200) { $ready = $true; break }
  } catch {}
  Start-Sleep -Milliseconds 200
}
if ($ready) { Write-Ok "Web ready" } else { Write-Warn "Web slow — opening anyway, browser will heal" }

# Persist child PIDs so a separate Stop-Novan script can find them.
$pidFile = Join-Path $cacheDir "service-pids.json"
$pidData = @{
  api     = $api.Id
  web     = $web.Id
  workers = @($workerProcs | ForEach-Object { $_.Id })
  startedAt = (Get-Date).ToString('o')
} | ConvertTo-Json
Set-Content -Path $pidFile -Value $pidData -Encoding utf8

Write-Host ""
Write-Host "  ┌─────────────────────────────────────────┐" -ForegroundColor DarkCyan
Write-Host "  │  Novan      →  http://localhost:3000     │" -ForegroundColor Cyan
Write-Host "  │  API Docs   →  http://localhost:3001/docs│" -ForegroundColor Cyan
Write-Host "  │  Stop       →  scripts\Stop-Novan.ps1    │" -ForegroundColor Cyan
Write-Host "  └─────────────────────────────────────────┘" -ForegroundColor DarkCyan
Write-Host ""

Start-Process "http://localhost:3000/brain"

# Give the browser a moment to grab the URL before we vanish so the
# operator's eyes track from the (now-fading) console to the new tab.
Start-Sleep -Milliseconds 400
Hide-ConsoleWindow
Stay-Awake     # prevent system sleep while the brain is running

# ── 10. Supervisor loop — keeps the brain alive 24/7 ──────────────────
# Walks the recorded child PIDs every 10 s. If any died (Node crashed,
# OOM, hung tsx watch process killed), respawns it. Persists restart
# counts to service-pids.json so the UI can show "alive for X hours,
# restarted N times".
#
# Exits cleanly when Stop-Novan.ps1 deletes service-pids.json.

$restartCounts = @{ api = 0; web = 0 }
foreach ($w in $workerNames) { $restartCounts[$w] = 0 }
$superStarted = (Get-Date).ToString('o')

function Write-PidFile {
  $data = @{
    api          = $api.Id
    web          = $web.Id
    workers      = @($workerProcs | ForEach-Object { $_.Id })
    workerNames  = $workerNames
    restartCounts = $restartCounts
    startedAt    = $superStarted
    lastCheckAt  = (Get-Date).ToString('o')
  } | ConvertTo-Json -Depth 4
  Set-Content -Path $pidFile -Value $data -Encoding utf8
}
Write-PidFile

function Process-Alive { param([int]$ProcId)
  if (-not $ProcId) { return $false }
  try { $null = Get-Process -Id $ProcId -ErrorAction Stop; return $true }
  catch { return $false }
}

$infraCheckCounter = 0
while (Test-Path $pidFile) {
  Start-Sleep -Seconds 10
  if (-not (Test-Path $pidFile)) { break }   # Stop-Novan signal

  # Infra supervisor — only matters in docker mode. Every 6th tick (~60s)
  # probe `docker info`; if down, try to restart Docker Desktop and the
  # containers. Native mode auto-restarts via Windows service recovery;
  # cloud mode is someone else's problem (Neon/Upstash uptime).
  $infraCheckCounter++
  if ($infraMode -eq 'docker' -and ($infraCheckCounter % 6) -eq 0) {
    if (-not (Test-Docker-Healthy)) {
      Write-Warn "Docker engine went down — attempting restart..."
      if (Start-Docker-Desktop) {
        Invoke-DockerSilent 'compose up -d postgres redis' | Out-Null
        Write-Ok "Docker + containers restarted"
      }
    } else {
      $running = Invoke-DockerCapture 'compose ps --services --filter status=running'
      if (-not ($running -match 'postgres') -or -not ($running -match 'redis')) {
        Write-Warn "Containers missing — restarting..."
        Invoke-DockerSilent 'compose up -d postgres redis' | Out-Null
      }
    }
  } elseif ($infraMode -eq 'native' -and ($infraCheckCounter % 6) -eq 0) {
    Start-Native-Infra   # idempotent; re-Start-Service any that stopped
  }

  # API — respawn if dead
  if (-not (Process-Alive $api.Id)) {
    $restartCounts['api']++
    $api = Start-HiddenService -Name "api" -PnpmFilter "api"
  }
  # Web
  if (-not (Process-Alive $web.Id)) {
    $restartCounts['web']++
    $web = Start-HiddenService -Name "web" -PnpmFilter "web"
  }
  # Workers — index-aligned with $workerNames
  for ($i = 0; $i -lt $workerProcs.Count; $i++) {
    if (-not (Process-Alive $workerProcs[$i].Id)) {
      $name = $workerNames[$i]
      $restartCounts[$name]++
      $workerProcs[$i] = Start-HiddenService -Name $name -PnpmFilter $name
    }
  }
  Write-PidFile
}

# ── Shutdown ──────────────────────────────────────────────────────────
# Hidden pnpm.cmd children spawn their own node + tsx subprocesses.
# Killing the cmd shim alone leaves orphans, so we use taskkill /T to
# terminate the whole process tree per service.
function Stop-Tree {
  param([int]$ProcId)
  if ($ProcId) { & taskkill /PID $ProcId /T /F *> $null }
}
Stop-Tree -ProcId $api.Id
Stop-Tree -ProcId $web.Id
foreach ($wp in $workerProcs) { Stop-Tree -ProcId $wp.Id }
# Only stop containers in docker mode. Native services should keep
# running (other tools may use them); cloud is remote.
if ($infraMode -eq 'docker') { Invoke-DockerSilent 'compose stop postgres redis' | Out-Null }
Release-Awake
try { Stop-Transcript | Out-Null } catch {}
