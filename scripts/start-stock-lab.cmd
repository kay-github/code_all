@echo off
cd /d "%~dp0.."
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 22 or newer: https://nodejs.org/
  pause
  exit /b 1
)
echo Open http://127.0.0.1:8765/tools/stock-rebound-lab/ in your browser.
node scripts\serve-stock-lab.cjs
pause
