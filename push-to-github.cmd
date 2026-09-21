@echo off
rem =============================================================
rem  live2d-companion : publish to GitHub  (one-click uploader)
rem
rem  MAINTAINER WARNING - THIS FILE MUST STAY 100% ASCII
rem  No Chinese text and no Chinese punctuation anywhere, not
rem  even inside "rem" lines. cmd.exe parses .cmd files byte by
rem  byte using the OEM code page (936/GBK on this machine)
rem  BEFORE any chcp command can take effect. A UTF-8 Chinese
rem  character often ends with a byte such as 0x82, which GBK
rem  treats as a two-byte lead byte: it eats the trailing CR,
rem  the next line gets merged into this one, and cmd reports
rem  nonsense like "'echo' is not recognized as an internal
rem  or external command". Keep every prompt in English.
rem =============================================================

title Publish to GitHub

cd /d "%~dp0"
if errorlevel 1 goto :nocd

where git >nul 2>nul
if errorlevel 1 goto :nogit

echo.
echo ============================================================
echo    Live2D Desktop Pet  -  Publish to GitHub
echo ============================================================
echo.
echo  Your files are already saved on this computer.
echo  (1 commit, 140 files)
echo.
echo  Now we only need to upload them.
echo.
echo ------------------------------------------------------------
echo    STEP 1  -  Create an empty repository on GitHub
echo ------------------------------------------------------------
echo  Open this address in your browser:
echo.
echo        https://github.com/new
echo.
echo  Then:
echo     1. Repository name ......... live2d-companion
echo     2. Description ............. optional, can be empty
echo     3. Choose  Private  or  Public
echo     4. DO NOT tick "Add a README file"
echo     5. DO NOT tick "Add .gitignore"
echo     6. DO NOT tick "Choose a license"
echo     7. Click the green button   Create repository
echo.
echo  IMPORTANT: those three checkboxes must stay EMPTY.
echo  If GitHub already shows you a page with commands in it,
echo  you did it right. Come back here and continue.
echo ------------------------------------------------------------
echo.
pause

echo.
echo ------------------------------------------------------------
echo    STEP 2  -  Tell me where to upload
echo ------------------------------------------------------------
echo  Just press Enter to accept the default shown in brackets.
echo.

set "GHUSER=KuroMata"
set /p GHUSER=Your GitHub username [Enter = KuroMata]:
if "%GHUSER%"=="" set "GHUSER=KuroMata"

set "REPO=live2d-companion"
set /p REPO=Repository name [Enter = live2d-companion]:
if "%REPO%"=="" set "REPO=live2d-companion"

echo.
echo ------------------------------------------------------------
echo    STEP 3  -  Uploading
echo ------------------------------------------------------------
echo.
echo  Destination:  https://github.com/%GHUSER%/%REPO%
echo.
echo  A browser window may open asking you to sign in to GitHub.
echo  Sign in, then click the green  Authorize  button.
echo  If no window appears, look at your taskbar.
echo.
echo  Press any key when you are ready to upload...
pause >nul

git branch -M main
git remote remove origin >nul 2>nul
git remote add origin https://github.com/%GHUSER%/%REPO%.git
if errorlevel 1 goto :fail

echo.
echo  Uploading, please wait...
echo.

git push -u origin main
if errorlevel 1 goto :fail

echo.
echo ============================================================
echo    SUCCESS
echo.
echo    https://github.com/%GHUSER%/%REPO%
echo.
echo    Open that link to see your project on GitHub.
echo ============================================================
echo.
pause
exit /b 0

:nogit
echo.
echo [ERROR] git was not found on this computer.
echo Install Git for Windows first:  https://git-scm.com/download/win
echo.
pause
exit /b 1

:nocd
echo.
echo [ERROR] Cannot enter the script folder.
echo.
pause
exit /b 1

:fail
echo.
echo ============================================================
echo    UPLOAD FAILED
echo ============================================================
echo.
echo  Most common causes:
echo    1. The repository was not created yet
echo       (go to https://github.com/new and create it first)
echo    2. Username or repository name typed incorrectly
echo    3. The browser sign-in was cancelled
echo.
echo  Nothing was lost. All your files are still safe
echo  on this computer. Fix the cause and run this
echo  script again - it is safe to run many times.
echo.
pause
exit /b 1
