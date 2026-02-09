@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
echo Current folder: %CD%
echo.

set GITCMD=git
if exist "%~dp0git-path.txt" (
    set /p GITCMD=<"%~dp0git-path.txt"
    set "GITCMD=!GITCMD: =!"
)
if "!GITCMD!"=="" set GITCMD=git
where git >nul 2>nul
if errorlevel 1 (
    if exist "C:\Program Files\Git\bin\git.exe" set "GITCMD=C:\Program Files\Git\bin\git.exe"
    if "!GITCMD!"=="git" if exist "C:\Program Files (x86)\Git\bin\git.exe" set "GITCMD=C:\Program Files (x86)\Git\bin\git.exe"
    if "!GITCMD!"=="git" if exist "%LOCALAPPDATA%\Programs\Git\bin\git.exe" set "GITCMD=%LOCALAPPDATA%\Programs\Git\bin\git.exe"
)
echo --- Step 1: Checking git ---
"%GITCMD%" --version 2>nul
if errorlevel 1 (
    echo ERROR: Git not found.
    echo.
    echo Install Git: https://git-scm.com/download/win
    echo During setup, choose "Git from the command line and also from 3rd-party software".
    echo Then run this batch file again.
    echo.
    echo If Git is already installed elsewhere, create a file "git-path.txt" in this
    echo folder with one line: the full path to git.exe e.g. D:\Tools\Git\bin\git.exe
    echo.
    echo ----------------------------------------
    echo Press ENTER or SPACE on your KEYBOARD to close (mouse click does not work).
    echo ----------------------------------------
    pause >nul
    exit /b 1
)
echo.

echo --- Step 2: Status ---
"%GITCMD%" status
echo.

echo --- Step 3: Add all files ---
"%GITCMD%" add -A
echo.

echo --- Step 4: Commit ---
"%GITCMD%" commit -m "Multi-strategy trades, strategy-specific stops/TPs, coin data fixes, Learn update"
if errorlevel 1 (
    echo Commit failed or nothing to commit. Check above.
    echo Press ENTER or SPACE on your KEYBOARD to close.
    pause >nul
    exit /b 1
)
echo.

echo --- Step 5: Push to origin main ---
"%GITCMD%" push origin main
if errorlevel 1 (
    echo.
    echo PUSH FAILED - usually means token/password is wrong or expired.
    echo 1. Go to GitHub.com - Settings - Developer settings - Personal access tokens
    echo 2. Generate a new token with "repo" scope
    echo 3. When you run "git push" again, use that token as the PASSWORD
    echo    Or: Windows Credential Manager - find github.com - edit password to new token
    echo.
    echo Press ENTER or SPACE on your KEYBOARD to close.
    pause >nul
) else (
    echo.
    echo Done. Press ENTER or SPACE to close.
    pause >nul
)
