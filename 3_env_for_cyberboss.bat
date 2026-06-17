@echo off
setlocal EnableExtensions

cd /d "%~dp0"
if not exist "%~dp0setup_scripts\configure_cyberboss_ga.ps1" (
  echo Missing setup_scripts\configure_cyberboss_ga.ps1
  pause
  exit /b 1
)

echo Configuring CyberBoss environment...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup_scripts\configure_cyberboss_ga.ps1" -Interactive
if errorlevel 1 (
  echo.
  echo CyberBoss env setup failed. Please check the error above.
  pause
  exit /b 1
)

echo.
echo CyberBoss env setup complete.
pause
exit /b 0