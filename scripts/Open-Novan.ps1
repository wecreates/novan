# ╔══════════════════════════════════════════════════════════════════════╗
# ║              NOVAN — INSTANT OPEN                                    ║
# ║                                                                      ║
# ║  Click → browser opens.                                              ║
# ║                                                                      ║
# ║  Hot path (services already running):   ~300 ms                     ║
# ║  Cold path (need to boot everything):   falls through to launch.ps1 ║
# ║                                                                      ║
# ║  Pin THIS to your taskbar, not launch.ps1.                          ║
# ╚══════════════════════════════════════════════════════════════════════╝

$ErrorActionPreference = "SilentlyContinue"
$ROOT = Split-Path $PSScriptRoot -Parent

# Hide our own window immediately so the operator never sees a flash.
if (-not ([System.Management.Automation.PSTypeName]'NovanOpenWin32').Type) {
  Add-Type -Namespace NovanOpenWin32 -Name Native -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll")]
public static extern System.IntPtr GetConsoleWindow();
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);
'@
}
$consoleHandle = [NovanOpenWin32.Native]::GetConsoleWindow()
if ($consoleHandle -ne [IntPtr]::Zero) { [void][NovanOpenWin32.Native]::ShowWindow($consoleHandle, 0) }

# ── Hot path: probe API + web simultaneously with 800 ms total budget ──
$apiAlive = $false
$webAlive = $false
$apiJob = Start-Job -ScriptBlock {
  try {
    $r = Invoke-WebRequest -Uri "http://localhost:3001/health" -TimeoutSec 1 -UseBasicParsing
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}
$webJob = Start-Job -ScriptBlock {
  try {
    $r = Invoke-WebRequest -Uri "http://localhost:3000" -TimeoutSec 1 -UseBasicParsing
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}
$null = Wait-Job -Job $apiJob, $webJob -Timeout 2
$apiAlive = (Receive-Job -Job $apiJob -ErrorAction SilentlyContinue) -eq $true
$webAlive = (Receive-Job -Job $webJob -ErrorAction SilentlyContinue) -eq $true
Remove-Job -Job $apiJob, $webJob -Force -ErrorAction SilentlyContinue

if ($apiAlive -and $webAlive) {
  # Both up — open browser instantly and exit.
  Start-Process "http://localhost:3000/brain"
  exit 0
}

# ── Cold path: services down. Show the window again and run full launch.
if ($consoleHandle -ne [IntPtr]::Zero) { [void][NovanOpenWin32.Native]::ShowWindow($consoleHandle, 5) }
& (Join-Path $PSScriptRoot "launch.ps1")
