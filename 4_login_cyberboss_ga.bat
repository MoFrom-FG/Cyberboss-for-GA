@echo off
setlocal EnableExtensions EnableDelayedExpansion

cd /d "%~dp0"
set "WORKSPACE_ROOT=%~dp0"
set "CYBERBOSS_HOME=%WORKSPACE_ROOT%cyberboss-main"
set "CYBERBOSS_CONDA_ENV=%WORKSPACE_ROOT%.conda\env"

if exist "%WORKSPACE_ROOT%setup_scripts\configure_cyberboss_ga.ps1" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%WORKSPACE_ROOT%setup_scripts\configure_cyberboss_ga.ps1" -PathOnly
  if errorlevel 1 exit /b 1
)

call :load_env_file "%WORKSPACE_ROOT%.env"
call :load_env_file "%WORKSPACE_ROOT%cyberboss-main\.env"
call :normalize_path CYBERBOSS_HOME
call :normalize_conda_env

set "CONDA_BAT="
if exist "%WORKSPACE_ROOT%.conda\miniconda\condabin\conda.bat" set "CONDA_BAT=%WORKSPACE_ROOT%.conda\miniconda\condabin\conda.bat"
if not defined CONDA_BAT if exist "%CONDA_PREFIX%\condabin\conda.bat" set "CONDA_BAT=%CONDA_PREFIX%\condabin\conda.bat"
if not defined CONDA_BAT if exist "%CONDA_PREFIX%\..\..\condabin\conda.bat" set "CONDA_BAT=%CONDA_PREFIX%\..\..\condabin\conda.bat"
if not defined CONDA_BAT if exist "%USERPROFILE%\.conda\condabin\conda.bat" set "CONDA_BAT=%USERPROFILE%\.conda\condabin\conda.bat"
if not defined CONDA_BAT for /f "delims=" %%C in ('where conda.bat 2^>nul') do if not defined CONDA_BAT set "CONDA_BAT=%%C"

if not defined CONDA_BAT (
  echo Failed to find conda.bat. Run 1_install_cyberboss_ga.bat first.
  pause
  exit /b 1
)

set "ACTIVATED_ENV="
if exist "%CYBERBOSS_CONDA_ENV%\python.exe" (
  call "%CONDA_BAT%" activate "%CYBERBOSS_CONDA_ENV%"
  if not errorlevel 1 set "ACTIVATED_ENV=%CYBERBOSS_CONDA_ENV%"
)

if not defined ACTIVATED_ENV (
  call "%CONDA_BAT%" activate GA
  if not errorlevel 1 set "ACTIVATED_ENV=GA"
)

if not defined ACTIVATED_ENV (
  echo No GenericAgent conda env found.
  echo Expected local env: %CYBERBOSS_CONDA_ENV%
  echo Or global env name: GA
  echo Run 1_install_cyberboss_ga.bat first.
  pause
  exit /b 1
)

if not exist "%CYBERBOSS_HOME%\package.json" (
  echo Missing cyberboss package.json: %CYBERBOSS_HOME%\package.json
  pause
  exit /b 1
)

cd /d "%CYBERBOSS_HOME%"
echo Activated env: %ACTIVATED_ENV%
echo Running CyberBoss login...
npm run login
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if not "%EXIT_CODE%"=="0" echo Login command failed with exit code %EXIT_CODE%.
pause
exit /b %EXIT_CODE%

:load_env_file
if not exist "%~1" exit /b 0
for /f "usebackq tokens=1,* delims==" %%A in ("%~1") do (
  set "ENV_KEY=%%A"
  if not "!ENV_KEY!"=="" if not "!ENV_KEY:~0,1!"=="#" call :set_allowed_env "%%A" "%%B"
)
exit /b 0

:set_allowed_env
if /i "%~1"=="CYBERBOSS_HOME" set "%~1=%~2"
if /i "%~1"=="CYBERBOSS_CONDA_ENV" set "%~1=%~2"
if /i "%~1"=="CYBERBOSS_ACCOUNT_ID" set "%~1=%~2"
exit /b 0

:normalize_path
set "VALUE=!%~1!"
if not defined VALUE exit /b 0
if "%VALUE%"=="." (
  set "%~1=%WORKSPACE_ROOT%"
  exit /b 0
)
if "%VALUE:~1,2%"==":\" exit /b 0
if "%VALUE:~0,2%"=="\\" exit /b 0
set "%~1=%WORKSPACE_ROOT%%VALUE%"
exit /b 0

:normalize_conda_env
set "VALUE=!CYBERBOSS_CONDA_ENV!"
if not defined VALUE (
  set "CYBERBOSS_CONDA_ENV=%WORKSPACE_ROOT%.conda\env"
  exit /b 0
)
if "%VALUE:~1,2%"==":\" exit /b 0
if "%VALUE:~0,2%"=="\\" exit /b 0
if "%VALUE:~0,1%"=="." (
  set "CYBERBOSS_CONDA_ENV=%WORKSPACE_ROOT%%VALUE%"
  exit /b 0
)
echo %VALUE% | findstr /R "[\\/]" >nul
if not errorlevel 1 set "CYBERBOSS_CONDA_ENV=%WORKSPACE_ROOT%%VALUE%"
exit /b 0
