@echo off
setlocal
cd /d "%~dp0"
echo [Dev Companion] Installing project dependencies...
call npm install
if errorlevel 1 (
  echo.
  echo Dependency installation failed. Check your internet connection and Node.js/npm installation.
  pause
  exit /b 1
)
echo.
echo [Dev Companion] Starting desktop app...
call npm run dev
if errorlevel 1 (
  echo.
  echo The app exited with an error. See the output above.
  pause
  exit /b 1
)
endlocal
