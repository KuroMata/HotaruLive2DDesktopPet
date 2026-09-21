@echo off
setlocal
title Fetch BigVGAN vocoder (IndexTTS-2)
rem ===========================================================================
rem  Double-click this if try_voice.cmd stalls while downloading the vocoder.
rem  It runs fetch_vocoder.ps1, which pulls bigvgan_generator.pt (428 MB) over
rem  8 parallel connections. Safe to run again - it resumes.
rem  ASCII only - do not add Chinese characters to this file.
rem ===========================================================================

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0fetch_vocoder.ps1"

echo.
pause
endlocal
