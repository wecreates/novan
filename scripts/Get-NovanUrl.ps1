# Get-NovanUrl.ps1 -- show current public URL for the platform.
#
# Reads .launch-logs/public-tunnels.json (written by Go-Public.ps1).
# Prints the URL and copies it to clipboard.
#
# Run:
#   powershell -File scripts\Get-NovanUrl.ps1

$ROOT     = Split-Path $PSScriptRoot -Parent
$STATEFILE = Join-Path $ROOT '.launch-logs\public-tunnels.json'

if (-not (Test-Path $STATEFILE)) {
  Write-Host ""
  Write-Host "  [!] No public tunnel running." -ForegroundColor Yellow
  Write-Host ""
  Write-Host "  Start one:" -ForegroundColor Gray
  Write-Host "    powershell -File scripts\Go-Public.ps1" -ForegroundColor White
  Write-Host ""
  exit 1
}

try {
  $state = Get-Content $STATEFILE -Raw | ConvertFrom-Json
} catch {
  Write-Host "  [X] Could not parse public-tunnels.json: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}

# Verify the tunnel is actually alive
$alive = $false
try {
  $r = Invoke-WebRequest -Uri "$($state.webUrl)/" -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
  if ($r.StatusCode -eq 200) { $alive = $true }
} catch {}

Write-Host ""
if ($alive) {
  Write-Host "  [OK] Live" -ForegroundColor Green
} else {
  Write-Host "  [!] State file exists but URL does not respond - tunnel may be down." -ForegroundColor Yellow
  Write-Host "      Restart with: powershell -File scripts\Go-Public.ps1" -ForegroundColor DarkGray
}
Write-Host ""
Write-Host "  Web:  $($state.webUrl)" -ForegroundColor Cyan
Write-Host "  API:  $($state.apiUrl)" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Started:  $($state.startedAt)" -ForegroundColor DarkGray
if ($state.note) {
  Write-Host "  Note:     $($state.note)" -ForegroundColor DarkGray
}
Write-Host ""

# Copy web URL to clipboard
try {
  $state.webUrl | Set-Clipboard
  Write-Host "  (Web URL copied to clipboard)" -ForegroundColor DarkGray
  Write-Host ""
} catch {}
