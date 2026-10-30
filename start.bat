@echo off
rem DM authentication check: double-click to start. Needs Node.js 18 or newer (https://nodejs.org).
setlocal
cd /d "%~dp0backend"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from https://nodejs.org and run this again.
  pause
  exit /b 1
)
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 18 ? 0 : 1)"
if errorlevel 1 (
  echo Node.js 18 or newer is required. You have:
  node -v
  echo Install the LTS version from https://nodejs.org and run this again.
  pause
  exit /b 1
)

rem Packages are included in the shared copy; install them only when they are missing
if not exist node_modules\express (
  echo Installing packages...
  call npm install --omit=dev --no-audit --no-fund
  if errorlevel 1 (
    echo Package install failed. Check your internet connection and run this again.
    pause
    exit /b 1
  )
)

for /f %%p in ('node scripts\setup.js') do set PORT=%%p

echo Starting on http://localhost:%PORT%  (close this window to stop)
start "" cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:%PORT%"
node src\server.js
pause
