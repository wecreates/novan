# Create the Novan Desktop shortcut with the metallic-N icon.
# Run once: powershell -ExecutionPolicy Bypass -File scripts\Create-Shortcut.ps1
$ROOT     = Split-Path $PSScriptRoot -Parent
$SCRIPT   = "$ROOT\scripts\launch.ps1"
$ICON     = "$ROOT\apps\web\public\icon.ico"
$DESKTOP  = [Environment]::GetFolderPath('Desktop')
$SHORTCUT = "$DESKTOP\Novan.lnk"
$OLD_OPS  = "$DESKTOP\Ops Platform.lnk"

# Remove old branding shortcut if present
if (Test-Path $OLD_OPS) { Remove-Item $OLD_OPS -Force }

# Ensure icon exists; generate if missing
if (-not (Test-Path $ICON)) {
  & powershell -ExecutionPolicy Bypass -File "$ROOT\scripts\Generate-Icon.ps1" | Out-Null
}

$wsh  = New-Object -ComObject WScript.Shell
$link = $wsh.CreateShortcut($SHORTCUT)
$link.TargetPath       = 'powershell.exe'
$link.Arguments        = "-ExecutionPolicy Bypass -WindowStyle Normal -File `"$SCRIPT`""
$link.WorkingDirectory = $ROOT
$link.Description      = 'Launch Novan — autonomous operational intelligence platform'
$link.WindowStyle      = 1
$link.IconLocation     = "$ICON,0"
$link.Save()

Write-Host "Novan shortcut created: $SHORTCUT" -ForegroundColor Green
Write-Host "Double-click 'Novan' on your desktop to launch." -ForegroundColor Cyan
