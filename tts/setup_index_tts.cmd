@echo off
setlocal
title IndexTTS-2 Setup

rem ===========================================================================
rem  IndexTTS-2 one-click installer (ASCII only - do NOT add Chinese here)
rem  cmd.exe parses .cmd with the OEM codepage before chcp takes effect, so any
rem  non-ASCII byte can swallow the following CR and shred the script.
rem  All Chinese documentation lives in the .md guide instead.
rem
rem  NOTE (2026-09): the upstream repo no longer ships requirements.txt.
rem  It now uses uv (pyproject.toml + uv.lock), so dependencies are installed
rem  with "uv sync" into an isolated .venv inside the repo folder.
rem ===========================================================================

set "PY=C:\Users\Administrator\AppData\Local\Programs\Python\Python311\python.exe"
if not exist "%PY%" set "PY=python"
set "REPO=D:\index-tts"
set "MODEL=IndexTeam/IndexTTS-2"
set "MODELDIR=checkpoints_2"
set "MIRROR=https://pypi.tuna.tsinghua.edu.cn/simple"

echo ============================================================
echo   IndexTTS-2 installer
echo ============================================================
echo   python   : %PY%
echo   repo     : %REPO%
echo   weights  : %REPO%\%MODELDIR%
echo.
echo   This script will:
echo     1. check python
echo     2. install uv (the dependency manager this repo uses)
echo     3. clone / update the index-tts repo
echo     4. uv sync  - creates .venv, downloads torch (a few GB)
echo     5. download model weights (about 10 GB - SLOW)
echo.
echo   Keep this window open. Do not close it.
echo.
pause

echo.
echo [1/5] checking python ...
"%PY%" -c "import sys; print(sys.version)" || goto fail

echo.
echo [2/5] installing uv ...
"%PY%" -m pip install -U uv || goto fail
"%PY%" -m uv --version || goto fail

echo.
echo [3/5] getting the repo ...
where git >nul 2>nul || goto nogit
if exist "%REPO%\.git" (
  git -C "%REPO%" pull
) else (
  git clone https://github.com/index-tts/index-tts.git "%REPO%" || goto fail
)

echo.
echo [4/5] creating the python environment (uv sync - be patient) ...
rem  Check that the system python already has CUDA torch. Downloading torch from
rem  download.pytorch.org runs at ~0.2 MB/s from here (hours!), so we reuse the
rem  copy that is already installed instead.
"%PY%" -c "import torch; print('system torch', torch.__version__)" || goto notorch
pushd "%REPO%"
set "UV_PYTHON_DOWNLOADS=never"
set "UV_PYTHON=%PY%"
set "UV_HTTP_TIMEOUT=300"
set "UV_CONCURRENT_DOWNLOADS=16"
set "UV_LINK_MODE=copy"
rem  --system-site-packages: let .venv see the system torch / torchaudio
rem  --no-install-package torch/torchaudio: and do NOT download them again
"%PY%" -m uv venv --system-site-packages --python "%PY%" --allow-existing || goto fail
"%PY%" -m uv sync --python "%PY%" --no-install-package torch --no-install-package torchaudio --default-index "%MIRROR%" || goto fail
popd

echo.
echo [5/5] downloading model weights (about 10 GB, be patient) ...
set "VPY=%REPO%\.venv\Scripts\python.exe"
if not exist "%VPY%" (
  echo   FAILED: %VPY% not found - step 4 did not finish correctly.
  goto fail
)
if exist "%REPO%\.venv\Scripts\modelscope.exe" (
  "%REPO%\.venv\Scripts\modelscope.exe" download --model %MODEL% --local_dir "%REPO%\%MODELDIR%" || goto fail
) else (
  "%VPY%" -m modelscope.cli.cli download --model %MODEL% --local_dir "%REPO%\%MODELDIR%" || goto fail
)

echo.
if not exist "%REPO%\%MODELDIR%\config.yaml" (
  echo   FAILED: %REPO%\%MODELDIR%\config.yaml is missing.
  echo   The weights download did not complete. Re-run this script to resume.
  goto fail
)

echo.
echo ============================================================
echo   DONE
echo ============================================================
echo   env python : %VPY%
echo   weights    : %REPO%\%MODELDIR%
echo.
echo   Next:
echo     1. double-click  tts\try_voice.cmd  to make a test clip
echo     2. set these two keys in  app\config.json :
echo          "ttsPython"  : "%REPO%\.venv\Scripts\python.exe"
echo          "ttsEngine"  : "indextts"
echo        (remember to escape backslashes as \\ in JSON)
echo.
goto end

:notorch
echo.
echo ============================================================
echo   FAILED - the system python has no CUDA PyTorch.
echo   %PY% -c "import torch"  failed.
echo.
echo   Install it first (about 2.5 GB, use the Chinese mirror):
echo     %PY% -m pip install torch torchaudio --index-url https://mirrors.aliyun.com/pytorch-wheels/cu118
echo   then re-run this script.
echo ============================================================
goto end

:nogit
echo.
echo ============================================================
echo   FAILED - git was not found in PATH.
echo   Install Git for Windows, or download the repo ZIP manually:
echo     https://github.com/index-tts/index-tts   (Code - Download ZIP)
echo   then unzip it to %REPO% and re-run this script.
echo ============================================================
goto end

:fail
echo.
echo ============================================================
echo   FAILED at the step above.
echo   Copy the last messages in this window and send them to
echo   the assistant so we can fix it.
echo ============================================================

:end
echo.
pause
endlocal
