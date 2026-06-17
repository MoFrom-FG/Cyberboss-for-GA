@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "WORKSPACE_ROOT=%~dp0"
set "CYBERBOSS_WORKSPACE_ROOT=%WORKSPACE_ROOT%"
set "CYBERBOSS_HOME=%WORKSPACE_ROOT%cyberboss-main"
set "CYBERBOSS_STATE_DIR=%WORKSPACE_ROOT%cyberboss-data"
set "CYBERBOSS_GA_AGENTMAIN=%WORKSPACE_ROOT%GenericAgent-main\agentmain.py"
set "CYBERBOSS_GA_TASK_DIR=%WORKSPACE_ROOT%cyberboss-data\genericagent-sessions"
set "CYBERBOSS_CONDA_ENV=%WORKSPACE_ROOT%.conda\env"
set "GA_TASK_IDLE_TIMEOUT_SECONDS=36000"
set "TIMELINE_FOR_AGENT_STATE_DIR=%WORKSPACE_ROOT%cyberboss-data"
set "CYBERBOSS_SHARED_PORT=8765"
set "CYBERBOSS_CODEX_ENDPOINT=ws://127.0.0.1:8765"

if exist "%WORKSPACE_ROOT%setup_scripts\configure_cyberboss_ga.ps1" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%WORKSPACE_ROOT%setup_scripts\configure_cyberboss_ga.ps1" -PathOnly
  if errorlevel 1 exit /b 1
)

call :load_env_file "%WORKSPACE_ROOT%.env"
call :load_env_file "%WORKSPACE_ROOT%cyberboss-main\.env"
call :normalize_path CYBERBOSS_WORKSPACE_ROOT
call :normalize_path CYBERBOSS_HOME
call :normalize_path CYBERBOSS_STATE_DIR
call :normalize_path CYBERBOSS_GA_AGENTMAIN
call :normalize_path CYBERBOSS_GA_TASK_DIR
call :normalize_path TIMELINE_FOR_AGENT_STATE_DIR
call :normalize_conda_env

if /i "%~1"=="bridge" goto run_bridge
if /i "%~1"=="open" goto run_open

echo Cleaning existing CyberBoss GenericAgent bridge processes first...
call "%~dp0stop_cyberboss_ga.bat"

echo Opening CyberBoss shared:start and shared:open in two PowerShell windows...
start "CyberBoss shared:start" powershell.exe -NoProfile -ExecutionPolicy Bypass -NoExit -Command "& '%~f0' bridge"
timeout /t 3 /nobreak >nul
start "CyberBoss shared:open" powershell.exe -NoProfile -ExecutionPolicy Bypass -NoExit -Command "& '%~f0' open"
exit /b 0

:run_bridge
call :activate_ga
if errorlevel 1 exit /b 1
set "CYBERBOSS_RUNTIME=genericagent"
set "TIMELINE_FOR_AGENT_STATE_DIR=%CYBERBOSS_STATE_DIR%"
call :validate_account_id

cd /d "%CYBERBOSS_HOME%"
echo Starting CyberBoss shared bridge with GenericAgent
echo Workspace: %CYBERBOSS_WORKSPACE_ROOT%
npm run shared:start
exit /b %ERRORLEVEL%

:run_open
echo Waiting briefly before activating GenericAgent environment for shared:open...
timeout /t 5 /nobreak >nul
call :activate_ga
if errorlevel 1 exit /b 1
set "CYBERBOSS_RUNTIME=genericagent"
set "TIMELINE_FOR_AGENT_STATE_DIR=%CYBERBOSS_STATE_DIR%"
call :validate_account_id

cd /d "%CYBERBOSS_HOME%"
echo Waiting briefly for CyberBoss bridge startup...
timeout /t 3 /nobreak >nul
echo Opening CyberBoss shared session with GenericAgent
echo Workspace: %CYBERBOSS_WORKSPACE_ROOT%
npm run shared:open
exit /b %ERRORLEVEL%

:activate_ga
if not defined CYBERBOSS_CONDA_ENV set "CYBERBOSS_CONDA_ENV=%WORKSPACE_ROOT%.conda\env"
set "CONDA_BAT="
if exist "%WORKSPACE_ROOT%.conda\miniconda\condabin\conda.bat" set "CONDA_BAT=%WORKSPACE_ROOT%.conda\miniconda\condabin\conda.bat"
if exist "%CONDA_PREFIX%\condabin\conda.bat" set "CONDA_BAT=%CONDA_PREFIX%\condabin\conda.bat"
if not defined CONDA_BAT if exist "%CONDA_PREFIX%\..\..\condabin\conda.bat" set "CONDA_BAT=%CONDA_PREFIX%\..\..\condabin\conda.bat"
if not defined CONDA_BAT if exist "%USERPROFILE%\.conda\condabin\conda.bat" set "CONDA_BAT=%USERPROFILE%\.conda\condabin\conda.bat"
if not defined CONDA_BAT for /f "delims=" %%C in ('where conda.bat 2^>nul') do if not defined CONDA_BAT set "CONDA_BAT=%%C"

if not defined CONDA_BAT (
  echo Failed to find conda.bat
  exit /b 1
)

call "%CONDA_BAT%" activate "%CYBERBOSS_CONDA_ENV%"
if errorlevel 1 (
  echo Failed to activate conda env %CYBERBOSS_CONDA_ENV%
  exit /b 1
)
exit /b 0

:validate_account_id
set "CYBERBOSS_EFFECTIVE_STATE_DIR=%CYBERBOSS_STATE_DIR%"
set "CYBERBOSS_ENV_ACCOUNT_ID="
set "CYBERBOSS_ENV_FILE=%CYBERBOSS_HOME%\.env"
if exist "%CYBERBOSS_ENV_FILE%" (
  for /f "usebackq tokens=1,* delims==" %%A in ("%CYBERBOSS_ENV_FILE%") do (
    if /i "%%A"=="CYBERBOSS_ACCOUNT_ID" set "CYBERBOSS_ENV_ACCOUNT_ID=%%B"
  )
)
if defined CYBERBOSS_ENV_ACCOUNT_ID if exist "%CYBERBOSS_EFFECTIVE_STATE_DIR%\accounts\%CYBERBOSS_ENV_ACCOUNT_ID%.json" (
  if not "%CYBERBOSS_ACCOUNT_ID%"=="%CYBERBOSS_ENV_ACCOUNT_ID%" echo Using CYBERBOSS_ACCOUNT_ID from %CYBERBOSS_ENV_FILE%.
  set "CYBERBOSS_ACCOUNT_ID=%CYBERBOSS_ENV_ACCOUNT_ID%"
  exit /b 0
)
if defined CYBERBOSS_ACCOUNT_ID if exist "%CYBERBOSS_EFFECTIVE_STATE_DIR%\accounts\%CYBERBOSS_ACCOUNT_ID%.json" exit /b 0
if not defined CYBERBOSS_ACCOUNT_ID exit /b 0
echo Ignoring stale CYBERBOSS_ACCOUNT_ID; account file was not found.
set "CYBERBOSS_ACCOUNT_ID="
exit /b 0

:load_env_file
if not exist "%~1" exit /b 0
for /f "usebackq tokens=1,* delims==" %%A in ("%~1") do (
  set "ENV_KEY=%%A"
  if not "!ENV_KEY!"=="" if not "!ENV_KEY:~0,1!"=="#" call :set_allowed_env "%%A" "%%B"
)
exit /b 0

:set_allowed_env
if /i "%~1"=="CYBERBOSS_WORKSPACE_ROOT" set "%~1=%~2"
if /i "%~1"=="CYBERBOSS_HOME" set "%~1=%~2"
if /i "%~1"=="CYBERBOSS_STATE_DIR" set "%~1=%~2"
if /i "%~1"=="CYBERBOSS_CONDA_ENV" set "%~1=%~2"
if /i "%~1"=="CYBERBOSS_ACCOUNT_ID" set "%~1=%~2"
if /i "%~1"=="CYBERBOSS_GA_AGENTMAIN" set "%~1=%~2"
if /i "%~1"=="CYBERBOSS_GA_TASK_DIR" set "%~1=%~2"
if /i "%~1"=="TIMELINE_FOR_AGENT_STATE_DIR" set "%~1=%~2"
if /i "%~1"=="CYBERBOSS_SHARED_PORT" set "%~1=%~2"
if /i "%~1"=="CYBERBOSS_CODEX_ENDPOINT" set "%~1=%~2"
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
