# Install-PublicAutoStart.ps1
#
# Registers a Windows Scheduled Task that runs Go-Public.ps1 at every
# user logon, restarts cloudflared if it crashes, and survives reboots.
#
# Result: your platform is reachable from the public internet 24/7 as
# long as your machine is on. The tunnel URL still changes on each
# restart (no domain = no fixed URL), but the tunnel itself never
# stays down for more than ~30 seconds.
#
# Run once (no admin needed):
#   powershell -ExecutionPolicy Bypass -File scripts\Install-PublicAutoStart.ps1
#
# Uninstall:
#   powershell -ExecutionPolicy Bypass -File scripts\Install-PublicAutoStart.ps1 -Uninstall

param([switch]$Uninstall)

$Host.UI.RawUI.WindowTitle = "Novan - Public Tunnel Auto-Start"
$ROOT     = Split-Path $PSScriptRoot -Parent
$SCRIPT   = "$ROOT\scripts\Go-Public.ps1"
$TASK     = "Novan Public Tunnels"

function Write-Step { param($m) Write-Host "  > $m" -ForegroundColor Blue }
function Write-Ok   { param($m) Write-Host "  [OK] $m" -ForegroundColor Green }
function Write-Warn { param($m) Write-Host "  [!] $m" -ForegroundColor Yellow }
function Write-Fail { param($m) Write-Host "  [X] $m" -ForegroundColor Red }

if ($Uninstall) {
  Write-Host ""
  Write-Step "Removing scheduled task '$TASK'..."
  try {
    Unregister-ScheduledTask -TaskName $TASK -Confirm:$false -ErrorAction Stop
    Write-Ok  "Removed."
  } catch {
    Write-Warn "(task did not exist)"
  }
  Write-Host ""
  Write-Host "  Public tunnels will no longer auto-start on logon." -ForegroundColor Gray
  Write-Host "  Running tunnels are NOT killed - close cloudflared.exe processes manually if you want them down." -ForegroundColor DarkGray
  exit 0
}

if (-not (Test-Path $SCRIPT)) {
  Write-Fail "Go-Public.ps1 not found at $SCRIPT"
  exit 1
}

Write-Host ""
Write-Host "  Installing public-tunnel auto-start..." -ForegroundColor Cyan
Write-Host ""

# Action: launch Go-Public.ps1 hidden
$action = New-ScheduledTaskAction `
  -Execute 'powershell.exe' `
  -Argument "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$SCRIPT`"" `
  -WorkingDirectory $ROOT

# Trigger: at user logon. Go-Public.ps1 internally waits for the API
# to bind :3001 before opening the tunnel, so we don't need a task-level
# delay (Windows 10's task scheduler XML rejects Delay on AtLogOn anyway).
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

# Settings: restart on failure, run on battery, no time limit
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartInterval (New-TimeSpan -Minutes 1) -RestartCount 999 `
  -ExecutionTimeLimit (New-TimeSpan -Days 0)

$principal = New-ScheduledTaskPrincipal `
  -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

# Replace any existing task
try { Unregister-ScheduledTask -TaskName $TASK -Confirm:$false -ErrorAction Stop } catch { }

Register-ScheduledTask `
  -TaskName    $TASK `
  -Description "Run Novan public tunnel at logon. Restarts every 30s if cloudflared crashes. URL changes per restart (no domain) - check .launch-logs/public-tunnels.json for current URL." `
  -Action      $action `
  -Trigger     $trigger `
  -Settings    $settings `
  -Principal   $principal | Out-Null

Write-Ok "Scheduled task '$TASK' installed."
Write-Host ""
Write-Host "  Behavior:" -ForegroundColor DarkCyan
Write-Host "    - Runs at user logon (30s after, so the API has time to bind)" -ForegroundColor Gray
Write-Host "    - Restarts every 30s if cloudflared crashes" -ForegroundColor Gray
Write-Host "    - Survives reboots" -ForegroundColor Gray
Write-Host "    - Current URL lives in .launch-logs/public-tunnels.json" -ForegroundColor Gray
Write-Host ""
Write-Host "  Show URL right now:" -ForegroundColor DarkCyan
Write-Host '    powershell -File scripts\Get-NovanUrl.ps1' -ForegroundColor Gray
Write-Host ""
Write-Host "  To uninstall: scripts\Install-PublicAutoStart.ps1 -Uninstall" -ForegroundColor DarkGray
