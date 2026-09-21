@echo off
rem ============================================================
rem  Live2D Companion - debug launcher
rem
rem  Same as start.cmd, except electron runs in the FOREGROUND and
rem  this window stays open, so every startup error is visible.
rem  Use this whenever start.cmd seems to do nothing.
rem
rem  Keep this file pure ASCII - see the note in start.cmd.
rem ============================================================

setlocal enableextensions
set "ELECTRON_RUN_AS_NODE="
cd /d "%~dp0"

if not exist "%~dp0node_modules\electron\dist\electron.exe" (
  echo [ERROR] electron.exe not found. Run "npm install" first.
  echo.
  pause
  exit /b 1
)

echo [live2d-companion] debug mode - electron runs in the foreground.
echo Press Ctrl+C to quit. Any startup error shows up below.
echo.

"%~dp0node_modules\electron\dist\electron.exe" "%~dp0."

echo.
echo [live2d-companion] electron exited with code %ERRORLEVEL%
pause
