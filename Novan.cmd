@echo off
REM ╔══════════════════════════════════════════════════════════════════════╗
REM ║   NOVAN — Click to open                                              ║
REM ║   Pin this to your taskbar for instant access.                       ║
REM ║                                                                      ║
REM ║   Hot path:  browser opens in <500ms (services already running)     ║
REM ║   Cold path: full launch + browser opens when ready                  ║
REM ╚══════════════════════════════════════════════════════════════════════╝
start "" /min powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0scripts\Open-Novan.ps1"
exit /b 0
