@echo off
cd /d "%~dp0"
title Commit and Push - voting-app

echo.
echo ========================================
echo   Commit and Push (voting-app)
echo ========================================
echo Folder: %CD%
echo.
timeout /t 1 /nobreak >nul

set GITCMD=git
where git >nul 2>nul
if errorlevel 1 (
    if exist "C:\Program Files\Git\bin\git.exe" set "GITCMD=C:\Program Files\Git\bin\git.exe"
)
if "%GITCMD%"=="git" if exist "C:\Program Files (x86)\Git\bin\git.exe" set "GITCMD=C:\Program Files (x86)\Git\bin\git.exe"
if "%GITCMD%"=="git" if exist "%LOCALAPPDATA%\Programs\Git\bin\git.exe" set "GITCMD=%LOCALAPPDATA%\Programs\Git\bin\git.exe"
if exist "%~dp0git-path.txt" set /p GITCMD=<"%~dp0git-path.txt"

echo --- Step 1: Checking git ---
"%GITCMD%" --version 2>nul
if errorlevel 1 (
    echo ERROR: Git not found. Install from https://git-scm.com/download/win
    echo Or put the path to git.exe in git-path.txt in this folder.
    goto :done
)
echo.

echo --- Step 2: Status ---
"%GITCMD%" status
echo.

echo --- Step 3: Add all ---
"%GITCMD%" add -A
echo.

echo --- Step 4: Commit ---
"%GITCMD%" commit -m "Multi-strategy trades, strategy-specific stops/TPs, coin data fixes, Learn update"
if errorlevel 1 (
    echo Commit failed or nothing to commit.
    goto :done
)
echo.

echo --- Step 5: Push ---
"%GITCMD%" push origin main
if errorlevel 1 (
    echo PUSH FAILED - update GitHub token in Credential Manager.
) else (
    echo Done. Pushed to main.
)

:done
echo.
echo ========================================
echo  DO NOT CLICK THE WINDOW.
echo  Press SPACEBAR or ENTER on your KEYBOARD to close.
echo ========================================
pause
