@echo off
cd /d "%~dp0"
echo Current folder: %CD%
echo.

set GITCMD=git
where git >nul 2>nul
if errorlevel 1 (
    if exist "C:\Program Files\Git\bin\git.exe" set GITCMD="C:\Program Files\Git\bin\git.exe"
    if exist "C:\Program Files (x86)\Git\bin\git.exe" set GITCMD="C:\Program Files (x86)\Git\bin\git.exe"
)
echo --- Step 1: Checking git ---
%GITCMD% --version
if errorlevel 1 (
    echo ERROR: Git not found. Install Git for Windows.
    pause
    exit /b 1
)
echo.

echo --- Step 2: Status ---
%GITCMD% status
echo.

echo --- Step 3: Add all files ---
%GITCMD% add -A
echo.

echo --- Step 4: Commit ---
%GITCMD% commit -m "Add order blocks, FVG and liquidity clusters to trading engine"
if errorlevel 1 (
    echo Commit failed or nothing to commit. Check above.
    pause
    exit /b 1
)
echo.

echo --- Step 5: Push to origin main ---
%GITCMD% push origin main
if errorlevel 1 (
    echo.
    echo PUSH FAILED - usually means token/password is wrong or expired.
    echo 1. Go to GitHub.com - Settings - Developer settings - Personal access tokens
    echo 2. Generate a new token with "repo" scope
    echo 3. When you run "git push" again, use that token as the PASSWORD
    echo    Or: Windows Credential Manager - find github.com - edit password to new token
)
echo.
pause
