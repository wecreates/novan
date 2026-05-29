# Stop-Novan.ps1 — clean teardown for the hidden launcher.
#
# The main launch.ps1 hides its console window after the browser opens
# and then sits in an invisible idle loop, holding the child PIDs of
# the API, Web, and worker processes. This script signals shutdown by
# deleting the service-pids.json file the launcher polls, then makes
# sure any orphaned trees are killed too.
#
# Wired to the desktop via Create-Shortcut.ps1 (or run directly).

$Host.UI.RawUI.WindowTitle = "Novan · Stop"
$ROOT     = Split-Path $PSScriptRoot -Parent
$pidFile  = Join-Path $ROOT ".launch-logs\service-pids.json"

Write-Host ""
Write-Host "  Stopping Novan..." -ForegroundColor Yellow

# 1. Read PIDs the launcher persisted on boot.
$pids = @()
if (Test-Path $pidFile) {
  try {
    $j = Get-Content $pidFile -Raw | ConvertFrom-Json
    if ($j.api)     { $pids += [int]$j.api }
    if ($j.web)     { $pids += [int]$j.web }
    if ($j.workers) { $pids += @($j.workers | ForEach-Object { [int]$_ }) }
  } catch {
    Write-Host "  (could not parse pid file — falling back to broad cleanup)" -ForegroundColor DarkGray
  }
  # Signal the launcher's idle loop to exit cleanly.
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
} else {
  Write-Host "  (no pid file — using broad cleanup)" -ForegroundColor DarkGray
}

# 2. Kill the recorded process trees first (most reliable).
foreach ($pidVal in $pids) {
  & taskkill /PID $pidVal /T /F *> $null
}

# 3. Belt-and-braces: kill any leftover pnpm/tsx/vite/node tied to our repo.
#    Filter by command line so we don't accidentally kill the user's
#    other Node processes.
Get-CimInstance Win32_Process |
  Where-Object {
    $_.CommandLine -and $_.CommandLine -match [regex]::Escape($ROOT) -and
    $_.Name -match '^(node|pnpm|tsx|vite)\.(exe|cmd)$'
  } |
  ForEach-Object { & taskkill /PID $_.ProcessId /T /F *> $null }

# 4. Stop the launcher process if it's still hanging around invisibly.
Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -eq 'powershell.exe' -and $_.CommandLine -match 'launch\.ps1'
  } |
  ForEach-Object { & taskkill /PID $_.ProcessId /T /F *> $null }

# 5. Stop infra containers last so any final flushes land cleanly.
Set-Location $ROOT
docker compose stop postgres redis *> $null

Write-Host "  ✓ Novan stopped." -ForegroundColor Green
Start-Sleep -Seconds 1
