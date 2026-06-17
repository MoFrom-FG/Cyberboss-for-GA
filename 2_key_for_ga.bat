@echo off
setlocal EnableExtensions

cd /d "%~dp0"
if not exist "%~dp0setup_scripts\configure_ga_key.ps1" (
  echo Missing setup_scripts\configure_ga_key.ps1
  pause
  exit /b 1
)

echo Creating GenericAgent key file from Cyberboss-for-GA template...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup_scripts\configure_ga_key.ps1" %*
if errorlevel 1 (
  echo.
  echo Key setup failed. Please check the error above.
  pause
  exit /b 1
)

echo.
echo Key setup complete.
pause
exit /b 0