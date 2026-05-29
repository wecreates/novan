# novan.ps1 — runtime control CLI for Novan
#
# Wraps the launcher + supervisor + data directory so the operator
# has one entry point for everything. Each subcommand maps to a real
# action against actual state on disk; nothing is faked.
#
# Usage (from anywhere; pwsh recommended):
#   novan start        — launch (or relaunch) the supervised brain
#   novan stop         — graceful shutdown of API + web + workers
#   novan restart      — stop, wait, start
#   novan status       — supervisor + child PID snapshot from disk
#   novan logs [svc]   — tail launcher transcript or a specific service log
#   novan health       — hits /api/v1/self/home for a live health check
#   novan backup       — copies novan-data/db + .env to a timestamped tarball
#   novan restore <p>  — restores from a backup tarball
#   novan repair       — clears stale pid file + restarts services
#
# This script intentionally has no `update` command — pulling new code
# is a `git pull` + `pnpm install`, which the supervisor picks up on
# next restart. Hiding that behind a subcommand would obscure what's
# actually happening.

param(
  [Parameter(Position=0)] [string]$Cmd = 'status',
  [Parameter(Position=1)] [string]$Arg
)

$ROOT     = Split-Path $PSScriptRoot -Parent
$LAUNCH   = "$ROOT\scripts\launch.ps1"
$STOP     = "$ROOT\scripts\Stop-Novan.ps1"
$LOGDIR   = "$ROOT\.launch-logs"
$PIDFILE  = "$LOGDIR\service-pids.json"
$DATAROOT = "$ROOT\novan-data"

function Write-Step { param($m) Write-Host "  ▸ $m" -ForegroundColor Blue }
function Write-Ok   { param($m) Write-Host "  ✓ $m" -ForegroundColor Green }
function Write-Warn { param($m) Write-Host "  ⚠ $m" -ForegroundColor Yellow }
function Write-Fail { param($m) Write-Host "  ✗ $m" -ForegroundColor Red }

function Cmd-Start {
  if (Test-Path $PIDFILE) {
    Write-Warn "Supervisor pid file exists — checking if alive..."
    $j = Get-Content $PIDFILE -Raw | ConvertFrom-Json
    $apiAlive = $false
    try { $null = Get-Process -Id $j.api -ErrorAction Stop; $apiAlive = $true } catch {}
    if ($apiAlive) {
      Write-Ok "Novan already running (api PID $($j.api)). Use 'novan restart' to bounce."
      return
    }
    Write-Warn "Stale pid file — removing and re-launching"
    Remove-Item $PIDFILE -Force
  }
  Write-Step "Launching..."
  Start-Process powershell -ArgumentList @('-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',$LAUNCH) -WorkingDirectory $ROOT
  Write-Ok "Launcher spawned (background). Use 'novan status' to watch it come up."
}

function Cmd-Stop {
  if (-not (Test-Path $STOP)) { Write-Fail "Stop script not found: $STOP"; return }
  & powershell -ExecutionPolicy Bypass -File $STOP
}

function Cmd-Restart {
  Cmd-Stop
  Start-Sleep -Seconds 3
  Cmd-Start
}

function Cmd-Status {
  if (-not (Test-Path $PIDFILE)) {
    Write-Warn "No pid file — supervisor not running. Use 'novan start'."
    return
  }
  $j = Get-Content $PIDFILE -Raw | ConvertFrom-Json
  $mtime = (Get-Item $PIDFILE).LastWriteTime
  $ageS  = [int]((Get-Date) - $mtime).TotalSeconds

  Write-Host ""
  Write-Host "  Novan Supervisor" -ForegroundColor Cyan
  Write-Host "  ────────────────" -ForegroundColor DarkCyan
  $supTone = if ($ageS -lt 30) { 'Green' } elseif ($ageS -lt 120) { 'Yellow' } else { 'Red' }
  $supText = if ($ageS -lt 30) { 'alive' } elseif ($ageS -lt 120) { 'stale' } else { 'dead' }
  Write-Host "  Last tick:   $ageS s ago [$supText]" -ForegroundColor $supTone
  Write-Host "  Started at:  $($j.startedAt)" -ForegroundColor Gray
  Write-Host ""

  function Show-Child { param($name, $procId, $restarts)
    $alive = $false
    try { $null = Get-Process -Id $procId -ErrorAction Stop; $alive = $true } catch {}
    $dot  = if ($alive) { '●' } else { '○' }
    $tone = if ($alive) { 'Green' } else { 'Red' }
    $r    = if ($restarts -gt 0) { " (restarted $restarts×)" } else { "" }
    Write-Host ("  $dot {0,-22} PID {1,-7} {2}" -f $name, $procId, $r) -ForegroundColor $tone
  }

  Show-Child 'api' $j.api  $j.restartCounts.api
  Show-Child 'web' $j.web  $j.restartCounts.web
  if ($j.workers -and $j.workerNames) {
    for ($i = 0; $i -lt $j.workers.Count; $i++) {
      Show-Child $j.workerNames[$i] $j.workers[$i] $j.restartCounts.($j.workerNames[$i])
    }
  }
  Write-Host ""
}

function Cmd-Logs {
  if (-not (Test-Path $LOGDIR)) { Write-Fail "No log directory at $LOGDIR"; return }
  $svc = if ($Arg) { $Arg } else { 'launcher' }
  $file = if ($svc -eq 'launcher') {
    Get-ChildItem -Path $LOGDIR -Filter 'launch-*.log' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  } else {
    $candidate = Get-Item -Path "$LOGDIR\$svc.log" -ErrorAction SilentlyContinue
    if (-not $candidate) { $candidate = Get-Item -Path "$LOGDIR\$svc.err.log" -ErrorAction SilentlyContinue }
    $candidate
  }
  if (-not $file) { Write-Fail "No log file for '$svc'"; return }
  Write-Step "Tailing $($file.FullName)  (Ctrl-C to stop)"
  Get-Content $file.FullName -Wait -Tail 50
}

function Cmd-Health {
  try {
    $r = Invoke-RestMethod -Uri "http://localhost:3001/health" -TimeoutSec 3
    Write-Ok "API healthy: $($r | ConvertTo-Json -Compress)"
  } catch {
    Write-Fail "API unreachable on :3001 — $($_.Exception.Message)"
  }
  try {
    $r = Invoke-RestMethod -Uri "http://localhost:3000" -TimeoutSec 3 -Method Head
    Write-Ok "Web responding on :3000"
  } catch {
    Write-Fail "Web unreachable on :3000 — $($_.Exception.Message)"
  }
}

function Cmd-Backup {
  if (-not (Test-Path $DATAROOT)) {
    Write-Warn "No novan-data/ directory — run scripts\Init-NovanData.ps1 first"
    return
  }
  $ts = Get-Date -Format 'yyyyMMdd-HHmmss'
  $backupRoot = "$ROOT\novan-backups"
  if (-not (Test-Path $backupRoot)) { New-Item -ItemType Directory -Path $backupRoot | Out-Null }
  $target = "$backupRoot\novan-backup-$ts.zip"
  Write-Step "Compressing novan-data + .env → $target"
  $toCompress = @($DATAROOT)
  if (Test-Path "$ROOT\.env") { $toCompress += "$ROOT\.env" }
  Compress-Archive -Path $toCompress -DestinationPath $target -Force
  Write-Ok "Backup written: $target ($([math]::Round((Get-Item $target).Length / 1MB, 2)) MB)"
}

function Cmd-Restore {
  if (-not $Arg) { Write-Fail "Usage: novan restore <path-to-backup.zip>"; return }
  if (-not (Test-Path $Arg)) { Write-Fail "Backup file not found: $Arg"; return }
  Write-Warn "Restore will overwrite novan-data/ and .env. Continue? (y/N)"
  $confirm = Read-Host
  if ($confirm -ne 'y') { Write-Warn "Aborted."; return }
  if (Test-Path $DATAROOT) { Remove-Item $DATAROOT -Recurse -Force }
  Expand-Archive -Path $Arg -DestinationPath $ROOT -Force
  Write-Ok "Restore complete. Restart with 'novan restart'."
}

function Cmd-Repair {
  Write-Step "Clearing stale pid file..."
  if (Test-Path $PIDFILE) { Remove-Item $PIDFILE -Force }
  Write-Step "Killing any orphan pnpm/node processes from previous runs..."
  Get-Process -Name pnpm,node,tsx -ErrorAction SilentlyContinue | Where-Object {
    $_.MainWindowTitle -match 'Novan|api|web|worker' -or $_.Path -match 'ops-platform'
  } | ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
  Write-Ok "Cleared. Run 'novan start' to relaunch fresh."
}

function Cmd-Help {
  Write-Host @"

  novan — runtime control for the Novan brain

  Commands:
    novan start             Launch supervised brain (idempotent)
    novan stop              Graceful shutdown
    novan restart           Stop, wait, start
    novan status            Supervisor + child PID snapshot
    novan logs [service]    Tail log (launcher | api | web | <worker>)
    novan health            Probe API + Web liveness
    novan backup            Snapshot novan-data + .env → zip
    novan restore <zip>     Restore from a backup zip
    novan repair            Clear stale state + kill orphans
    novan help              This text

  State lives under:
    .launch-logs/           launcher transcripts + service logs + pid file
    novan-data/             persistent runtime data (init with Init-NovanData.ps1)

"@ -ForegroundColor Gray
}

switch ($Cmd.ToLower()) {
  'start'   { Cmd-Start }
  'stop'    { Cmd-Stop }
  'restart' { Cmd-Restart }
  'status'  { Cmd-Status }
  'logs'    { Cmd-Logs }
  'health'  { Cmd-Health }
  'backup'  { Cmd-Backup }
  'restore' { Cmd-Restore }
  'repair'  { Cmd-Repair }
  'help'    { Cmd-Help }
  default   { Cmd-Help }
}
