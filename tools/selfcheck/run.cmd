@echo off
rem ===========================================================================
rem  NOTE: keep this file pure ASCII (no Chinese). cmd.exe parses .cmd files with
rem  the current OEM code page (936/GBK here) BEFORE chcp takes effect. A UTF-8
rem  multi-byte char can swallow the following CR and merge two lines, which
rem  shreds the script into stray commands. All Chinese docs live in .md files.
rem ===========================================================================
rem  Selfcheck: make sure the main app is already running first (it starts the
rem  static server on 127.0.0.1:18765 which this script connects to).
rem
rem  ELECTRON_RUN_AS_NODE: if inherited with a non-empty value, electron.exe
rem  degrades to plain Node and every require('electron') returns a path string.
rem  Must be cleared before launching.
set ELECTRON_RUN_AS_NODE=
cd /d "%~dp0"

set "ELECTRON=%~dp0..\..\node_modules\electron\dist\electron.exe"

if not exist "%ELECTRON%" (
  echo [ERROR] electron.exe not found. Run npm install first.
  pause
  exit /b 1
)

rem Launch via PowerShell so the cleared variable is definitely the one the
rem child process inherits, and pass the app dir with a trailing dot.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$env:ELECTRON_RUN_AS_NODE=''; & '%ELECTRON%' '%~dp0.'"
set RC=%ERRORLEVEL%

echo.
echo selfcheck exit code: %RC%
echo results: %~dp0selfcheck-result.json
echo screenshot: %~dp0selfcheck-shot.png
pause
