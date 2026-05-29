# Go-Public.ps1 — expose your running local Novan via Cloudflare quick tunnels.
#
# Easiest deploy path: zero accounts, zero cost, public URL in ~60s.
#
# Trade-off: URLs are EPHEMERAL — they change every restart. For
# permanent URLs you need a Cloudflare account + `cloudflared tunnel
# login` (free) and a named tunnel config.
#
# What this does:
#   1. Verifies API on :3001 and Web on :3000 are reachable locally
#   2. Starts a Cloudflare quick tunnel for the API → captures the URL
#   3. Stops the running web, rebuilds it with VITE_API_BASE = the API URL
#   4. Restarts the web on :3000 with the new bundle
#   5. Starts a Cloudflare quick tunnel for the web → captures URL
#   6. Prints both public URLs
#
# Run from anywhere:
#   powershell -ExecutionPolicy Bypass -File scripts\Go-Public.ps1
#
# Stop with Ctrl-C in this window (kills both tunnels). The local
# services keep running afterward — the launcher's supervisor doesn't
# care about the tunnels.

$ErrorActionPreference = 'Continue'
$Host.UI.RawUI.WindowTitle = 'Novan — public tunnels'

function Write-Step { param($m) Write-Host "  ▸ $m" -ForegroundColor Blue }
function Write-Ok   { param($m) Write-Host "  ✓ $m" -ForegroundColor Green }
function Write-Warn { param($m) Write-Host "  ⚠ $m" -ForegroundColor Yellow }
function Write-Fail { param($m) Write-Host "  ✗ $m" -ForegroundColor Red }

Write-Host ''
Write-Host '  Novan — Cloudflare quick tunnel deploy' -ForegroundColor Cyan
Write-Host '  ──────────────────────────────────────' -ForegroundColor DarkCyan
Write-Host ''

# ── 1. Preflight: services must already be running ───────────────────
Write-Step 'Killing any stale Vite processes (prevent port collision with API)…'
# Vite without strictPort silently bumps 3000 -> 3001 on collision, then
# squats on the IPv6 loopback of :3001 next to the API. Requests resolving
# to ::1 hit Vite (which has no /api route) and hang forever. Always start
# from a clean slate.
Get-WmiObject Win32_Process | Where-Object {
  $_.CommandLine -like '*vite*' -and $_.Name -eq 'node.exe'
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2

Write-Step 'Checking API on :3001…'
try {
  $r = Invoke-WebRequest -Uri 'http://localhost:3001/health' -TimeoutSec 3 -UseBasicParsing
  if ($r.StatusCode -eq 200) { Write-Ok "API healthy" }
} catch {
  Write-Fail 'API not responding on :3001. Run scripts\launch.ps1 first.'
  exit 1
}

Write-Step 'Checking Web on :3000…'
try {
  $r = Invoke-WebRequest -Uri 'http://localhost:3000/' -TimeoutSec 3 -UseBasicParsing
  if ($r.StatusCode -eq 200) { Write-Ok "Web responding" }
} catch {
  Write-Fail 'Web not responding on :3000. Run scripts\launch.ps1 first.'
  exit 1
}

# ── 2. Start API tunnel + capture URL from its stderr ────────────────
$ROOT     = Split-Path $PSScriptRoot -Parent
$LOG_DIR  = Join-Path $ROOT '.launch-logs'
if (-not (Test-Path $LOG_DIR)) { New-Item -ItemType Directory $LOG_DIR | Out-Null }
$apiLog   = Join-Path $LOG_DIR 'tunnel-api.log'
$webLog   = Join-Path $LOG_DIR 'tunnel-web.log'

if (Test-Path $apiLog) { Remove-Item $apiLog -Force }
if (Test-Path $webLog) { Remove-Item $webLog -Force }

Write-Step 'Starting Cloudflare tunnel for API (:3001)…'
$apiProc = Start-Process cloudflared `
  -ArgumentList @('tunnel','--url','http://localhost:3001','--no-autoupdate','--logfile',$apiLog) `
  -PassThru -WindowStyle Hidden

# Cloudflared prints the trycloudflare.com URL within a few seconds.
$apiUrl = $null
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Milliseconds 700
  if (Test-Path $apiLog) {
    $match = (Get-Content $apiLog -Raw -ErrorAction SilentlyContinue) -match 'https://[a-z0-9-]+\.trycloudflare\.com'
    if ($match) { $apiUrl = $Matches[0]; break }
  }
}
if (-not $apiUrl) {
  Write-Fail 'Could not capture API tunnel URL. Check log: ' + $apiLog
  exit 1
}
Write-Ok "API public URL: $apiUrl"

# ── 3. Rebuild web with the API URL baked in ─────────────────────────
# The Vite dev server picks up VITE_* env vars on next start. We
# replace the running web with a fresh start that has VITE_API_BASE
# pointing at the public API URL.
Write-Step 'Stopping current web dev server…'
Get-Process node, pnpm -ErrorAction SilentlyContinue | Where-Object {
  $_.MainWindowTitle -match 'web' -or
  $_.CommandLine -match 'apps[/\\]web' -or
  $_.CommandLine -match '@ops/web'
} | ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
# Best-effort kill of any process listening on :3000
$port3000 = (netstat -ano | Select-String ':3000\s+.*LISTENING' | ForEach-Object {
  ($_ -split '\s+')[-1]
}) | Select-Object -Unique
foreach ($p in $port3000) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2
Write-Ok 'web stopped'

Write-Step "Restarting web with VITE_API_BASE=$apiUrl/api…"
$env:VITE_API_BASE = "$apiUrl/api"
$webProc = Start-Process pnpm `
  -ArgumentList @('--filter','@ops/web','dev') `
  -WorkingDirectory $ROOT `
  -PassThru -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $LOG_DIR 'web-public.log') `
  -RedirectStandardError  (Join-Path $LOG_DIR 'web-public.err.log')

# Wait for vite to bind :3000
$webReady = $false
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 1
  try {
    $r = Invoke-WebRequest -Uri 'http://localhost:3000/' -TimeoutSec 1 -UseBasicParsing -ErrorAction Stop
    if ($r.StatusCode -eq 200) { $webReady = $true; break }
  } catch {}
}
if (-not $webReady) {
  Write-Warn 'Web did not come up in 30s. Check ' + (Join-Path $LOG_DIR 'web-public.log')
} else {
  Write-Ok 'web bound :3000 with the public API URL'
}

# ── 4. Start Web tunnel ──────────────────────────────────────────────
Write-Step 'Starting Cloudflare tunnel for Web (:3000)…'
$webTunnelProc = Start-Process cloudflared `
  -ArgumentList @('tunnel','--url','http://localhost:3000','--no-autoupdate','--logfile',$webLog) `
  -PassThru -WindowStyle Hidden

$webUrl = $null
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Milliseconds 700
  if (Test-Path $webLog) {
    $match = (Get-Content $webLog -Raw -ErrorAction SilentlyContinue) -match 'https://[a-z0-9-]+\.trycloudflare\.com'
    if ($match) { $webUrl = $Matches[0]; break }
  }
}
if (-not $webUrl) {
  Write-Warn 'Could not capture Web tunnel URL. Check log: ' + $webLog
}

# ── 5. Report ─────────────────────────────────────────────────────────
Write-Host ''
Write-Host '  ┌──────────────────────────────────────────────────────────┐' -ForegroundColor DarkCyan
Write-Host '  │  ✓ Novan is now live on the internet                     │' -ForegroundColor Green
Write-Host '  └──────────────────────────────────────────────────────────┘' -ForegroundColor DarkCyan
Write-Host ''
Write-Host "  Web:  $webUrl" -ForegroundColor Cyan
Write-Host "  API:  $apiUrl" -ForegroundColor Cyan
Write-Host ''
Write-Host '  Open the Web URL in any browser, anywhere.' -ForegroundColor Gray
Write-Host '  These URLs are EPHEMERAL — they change if this window restarts.' -ForegroundColor DarkGray
Write-Host '  PIDs:  api-tunnel=' + $apiProc.Id + '  web-tunnel=' + $webTunnelProc.Id -ForegroundColor DarkGray
Write-Host ''
Write-Host '  Press Ctrl+C to stop the tunnels (local services keep running).' -ForegroundColor DarkGray

# Write the URLs to disk so other scripts / dashboards can find them
$status = @{
  apiUrl    = $apiUrl
  webUrl    = $webUrl
  apiPid    = $apiProc.Id
  webPid    = $webTunnelProc.Id
  startedAt = (Get-Date).ToString('o')
}
$status | ConvertTo-Json | Set-Content (Join-Path $LOG_DIR 'public-tunnels.json') -Encoding utf8

# Wait until either tunnel dies — that's our signal to clean up
try {
  Wait-Process -Id $apiProc.Id, $webTunnelProc.Id -ErrorAction Stop
} finally {
  Write-Host ''
  Write-Step 'Shutting down tunnels…'
  Stop-Process -Id $apiProc.Id      -Force -ErrorAction SilentlyContinue
  Stop-Process -Id $webTunnelProc.Id -Force -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $LOG_DIR 'public-tunnels.json') -ErrorAction SilentlyContinue
  Write-Ok 'tunnels stopped (local API + Web keep running)'
}
