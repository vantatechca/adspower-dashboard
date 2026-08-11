@echo off
setlocal
cd /d "%~dp0"

echo ============================================
echo   AdsPower Bridge - auto-start installer
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [!] Node.js is not installed or not on PATH.
  echo     Install Node 18+ from https://nodejs.org  then run this again.
  echo.
  pause & exit /b 1
)

if not exist ".env" (
  echo [!] bridge\.env is missing.
  echo     1. Copy .env.example to .env
  echo     2. Fill in CLOUD_URL and BRIDGE_TOKEN
  echo     Then run this installer again.
  echo.
  pause & exit /b 1
)

echo Installing dependencies...
call npm install
if errorlevel 1 ( echo npm install failed. & pause & exit /b 1 )
echo.

echo Registering hidden auto-start at every login...
schtasks /create /tn "AdsPowerBridge" /tr "wscript.exe \"%~dp0start-bridge.vbs\"" /sc onlogon /f
echo.

echo Starting the bridge now (hidden)...
wscript.exe "%~dp0start-bridge.vbs"
echo.

echo ============================================
echo   Done.
echo   The bridge now runs hidden at every login.
echo   Open the web app - the header should read
echo   "bridge online" within about 15 seconds.
echo ============================================
echo.
pause
