@echo off
setlocal
set "GIT=C:\Program Files\Git\bin\git.exe"
cd /d "%~dp0"

echo.
echo Pushing to GitHub...
echo.

set /p TOKEN="Paste your GitHub token (ghp_...) then press Enter: "
if "%TOKEN%"=="" (
  echo No token. Get one at https://github.com/settings/tokens
  pause
  exit /b 1
)

echo.
echo Setting HTTPS remote with token...
"%GIT%" remote set-url origin "https://Sharedvaluevending:%TOKEN%@github.com/Sharedvaluevending/voting-app"
echo.

for /f "tokens=*" %%i in ('"%GIT%" branch --show-current 2^>nul') do set BRANCH=%%i
if "%BRANCH%"=="" set BRANCH=main
echo Pushing branch: %BRANCH%
echo.

"%GIT%" push origin %BRANCH%
echo.
if %ERRORLEVEL% equ 0 (
  echo SUCCESS. Push completed.
) else (
  echo PUSH FAILED.
)
echo.
pause
