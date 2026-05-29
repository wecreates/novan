# Create the Novan + Stop-Novan desktop shortcuts with the metallic-N icon.
# Run once: powershell -ExecutionPolicy Bypass -File scripts\Create-Shortcut.ps1
$ROOT     = Split-Path $PSScriptRoot -Parent
$LAUNCH   = "$ROOT\scripts\launch.ps1"
$STOP     = "$ROOT\scripts\Stop-Novan.ps1"
$ICON     = "$ROOT\apps\web\public\icon.ico"
$DESKTOP  = [Environment]::GetFolderPath('Desktop')
$START    = "$DESKTOP\Novan.lnk"
$STOPLNK  = "$DESKTOP\Stop Novan.lnk"
$OLD_OPS  = "$DESKTOP\Ops Platform.lnk"

# Remove old branding shortcut if present
if (Test-Path $OLD_OPS) { Remove-Item $OLD_OPS -Force }

# Ensure icon exists; generate if missing
if (-not (Test-Path $ICON)) {
  & powershell -ExecutionPolicy Bypass -File "$ROOT\scripts\Generate-Icon.ps1" | Out-Null
}

$wsh  = New-Object -ComObject WScript.Shell

# ── Start shortcut: hidden window (the launcher hides itself anyway,
#    but starting hidden avoids the brief flash during the boot phase).
$link = $wsh.CreateShortcut($START)
$link.TargetPath       = 'powershell.exe'
$link.Arguments        = "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$LAUNCH`""
$link.WorkingDirectory = $ROOT
$link.Description      = 'Launch Novan — autonomous operational intelligence platform'
$link.WindowStyle      = 7  # Minimized (less flashy if Hidden is overridden)
$link.IconLocation     = "$ICON,0"
$link.Save()

# ── Stop shortcut: visible window so the operator sees teardown progress.
$stoplink = $wsh.CreateShortcut($STOPLNK)
$stoplink.TargetPath       = 'powershell.exe'
$stoplink.Arguments        = "-ExecutionPolicy Bypass -WindowStyle Normal -File `"$STOP`""
$stoplink.WorkingDirectory = $ROOT
$stoplink.Description      = 'Stop all Novan services'
$stoplink.WindowStyle      = 1
$stoplink.IconLocation     = "$ICON,0"
$stoplink.Save()

Write-Host "Novan shortcut created:      $START"   -ForegroundColor Green
Write-Host "Stop-Novan shortcut created: $STOPLNK" -ForegroundColor Green
Write-Host ""
Write-Host "Double-click 'Novan' to launch. The launcher will hide itself"  -ForegroundColor Cyan
Write-Host "the moment the browser opens. Use 'Stop Novan' to shut down."   -ForegroundColor Cyan
