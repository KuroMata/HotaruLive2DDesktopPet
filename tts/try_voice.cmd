@echo off
setlocal
title IndexTTS-2 test clip

rem ===========================================================================
rem  Make ONE test clip with IndexTTS-2 (ASCII only - no Chinese in this file).
rem  It sets the INDEXTTS_* vars for this window only, then calls tts/selftest.py.
rem
rem  IMPORTANT: the dependencies (torch etc.) live in the repo's .venv, so we
rem  must run the .venv python, not the system one.
rem ===========================================================================

set "REPO=D:\index-tts"
set "MODELDIR=checkpoints_2"
set "PY=%REPO%\.venv\Scripts\python.exe"
if not exist "%PY%" set "PY=C:\Users\Administrator\AppData\Local\Programs\Python\Python311\python.exe"
if not exist "%PY%" set "PY=python"

set "HERE=%~dp0"
set "INDEXTTS_DIR=%REPO%"
set "INDEXTTS_MODEL_DIR=%MODELDIR%"
set "INDEXTTS_BOYIFY=1"
set "INDEXTTS_SEMITONES=2.5"
set "INDEXTTS_EMO_ALPHA=0.85"

echo ============================================================
echo   IndexTTS-2 test clip
echo ============================================================
echo   python      : %PY%
echo   repo        : %INDEXTTS_DIR%
echo   weights     : %REPO%\%MODELDIR%
echo   boyify      : %INDEXTTS_BOYIFY%  (semitones %INDEXTTS_SEMITONES%)
echo.

if not exist "%INDEXTTS_DIR%" (
  echo   ERROR: %INDEXTTS_DIR% not found.
  echo   Run setup_index_tts.cmd first.
  echo.
  pause
  exit /b 1
)

if not exist "%REPO%\%MODELDIR%\config.yaml" (
  echo   ERROR: %REPO%\%MODELDIR%\config.yaml not found.
  echo   The model weights are not downloaded yet.
  echo   Double-click setup_index_tts.cmd first.
  echo.
  pause
  exit /b 1
)

echo   Generating ... first run loads the model and takes a while.
echo.
"%PY%" "%HERE%selftest.py" indextts || goto fail

echo.
echo ============================================================
echo   DONE - listen to:  tts\_out\sample_indextts.wav
echo ============================================================
echo   Pitch too high/low  : change INDEXTTS_SEMITONES (1.5 - 3.5)
echo   Emotion too strong  : change INDEXTTS_EMO_ALPHA (0.6 - 0.9)
echo   in this file: tts\try_voice.cmd
echo.
goto end

:fail
echo.
echo ============================================================
echo   FAILED. Copy the last messages and send them to the assistant.
echo ============================================================

:end
echo.
pause
endlocal
