@echo off
rem ============================================================
rem  Live2D Companion - launcher
rem
rem  Double-click this file. The console window closes by itself
rem  and the app keeps living in the system tray. It does not take
rem  a taskbar slot.
rem
rem  ------------------------------------------------------------
rem  KEEP THIS FILE PURE ASCII WITH CRLF LINE ENDINGS.
rem  cmd.exe parses the bytes of a .cmd file with the OEM code page
rem  - 936 on this machine - and it does so before any chcp can take
rem  effect. A multi-byte utf-8 character such as the CJK full stop
rem  ends with byte 0x82, which is a GBK lead byte: it swallows the
rem  following CR and merges the next line into the current one.
rem  The whole script is then silently shredded, showing symptoms
rem  like a not-recognized rem command and half-cut command lines.
rem  Never write comments or messages in Chinese here.
rem  ------------------------------------------------------------

setlocal enableextensions

rem Defence 1 - clear the variable that degrades electron.exe into
rem plain Node. When it is set, requiring electron only returns a
rem path string, the app object stays undefined, and no window ever
rem appears.
set "ELECTRON_RUN_AS_NODE="

rem Defence 2 - never depend on the caller current directory.
cd /d "%~dp0"

if not exist "%~dp0node_modules\electron\dist\electron.exe" (
  echo [ERROR] electron.exe not found:
  echo         %~dp0node_modules\electron\dist\electron.exe
  echo         Run "npm install" in this folder first.
  echo.
  pause
  exit /b 1
)

if not exist "%~dp0main.js" (
  echo [ERROR] main.js not found in %~dp0
  echo.
  pause
  exit /b 1
)

rem Defence 3 - launch detached, so this console can close at once
rem while the app keeps running on its own.
rem   The app directory is passed with a trailing dot. Without that
rem   dot the argument would end in a backslash, Electron would take
rem   the closing quote as escaped, and it would fail with a
rem   cannot-find-module error naming the project folder.
rem   PowerShell Start-Process is the verified path on this machine;
rem   a plain start command is kept as a fallback.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$env:ELECTRON_RUN_AS_NODE=''; Start-Process -FilePath '%~dp0node_modules\electron\dist\electron.exe' -ArgumentList '%~dp0.' -WindowStyle Hidden"
if errorlevel 1 (
  start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
)

rem Defence 4 - self check, by polling. If electron never shows up, keep
rem this window open and dump app.log instead of vanishing silently.
rem
rem   Why poll instead of one fixed sleep: PowerShell itself needs 1-2
rem   seconds just to start up before Start-Process even runs, so a single
rem   check after ~2 seconds sometimes fired too early, declared failure
rem   and left this window sitting at the pause prompt. Poll up to ~12s.
rem     ping is used as the delay because it never touches stdin, unlike
rem   timeout, which fails when the handle is redirected.
rem   The ping sits INSIDE the guard so the loop exits as soon as it finds
rem   the process instead of sleeping through the remaining iterations.
set "L2D_FOUND="
for /L %%i in (1,1,12) do (
  if not defined L2D_FOUND (
    ping -n 2 127.0.0.1 >nul
    tasklist /FI "IMAGENAME eq electron.exe" 2>nul | find /I "electron.exe" >nul
    if not errorlevel 1 set "L2D_FOUND=1"
  )
)

if not defined L2D_FOUND (
  echo.
  echo [WARN] electron.exe is not running - the app did not start.
  echo        Double-click start-debug.cmd to see the real error.
  echo.
  echo ---------- app.log ----------
  if exist "%~dp0app.log" (
    type "%~dp0app.log"
  ) else (
    echo app.log was not created, so main.js never ran.
  )
  echo -----------------------------
  echo.
  pause
  exit /b 1
)

exit /b 0
