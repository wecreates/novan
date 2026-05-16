# Run this once to create the desktop shortcut
$ROOT      = Split-Path $PSScriptRoot -Parent
$SCRIPT    = "$ROOT\scripts\launch.ps1"
$DESKTOP   = [Environment]::GetFolderPath("Desktop")
$SHORTCUT  = "$DESKTOP\Ops Platform.lnk"

$wsh  = New-Object -ComObject WScript.Shell
$link = $wsh.CreateShortcut($SHORTCUT)
$link.TargetPath       = "powershell.exe"
$link.Arguments        = "-ExecutionPolicy Bypass -WindowStyle Normal -File `"$SCRIPT`""
$link.WorkingDirectory = $ROOT
$link.Description      = "Launch Ops Platform - AI-powered operational intelligence"
$link.WindowStyle      = 1  # Normal window
# Use PowerShell icon as fallback (SVG not directly usable for .lnk icons)
$link.IconLocation     = "powershell.exe,0"
$link.Save()

Write-Host "Desktop shortcut created: $SHORTCUT" -ForegroundColor Green
Write-Host "Double-click 'Ops Platform' on your desktop to launch the full system." -ForegroundColor Cyan
