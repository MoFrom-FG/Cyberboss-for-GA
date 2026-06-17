@echo off
setlocal EnableExtensions EnableDelayedExpansion

cd /d "%~dp0"
set "WORKSPACE_ROOT=%~dp0"
set "CYBERBOSS_RUNTIME=genericagent"
if not defined CYBERBOSS_STATE_DIR set "CYBERBOSS_STATE_DIR=%WORKSPACE_ROOT%cyberboss-data"
if not defined CYBERBOSS_GA_TASK_DIR set "CYBERBOSS_GA_TASK_DIR=%WORKSPACE_ROOT%cyberboss-data\genericagent-sessions"
if not defined CYBERBOSS_CONDA_ENV set "CYBERBOSS_CONDA_ENV=%WORKSPACE_ROOT%.conda\env"

set "CONDA_BAT="
if exist "%WORKSPACE_ROOT%.conda\miniconda\condabin\conda.bat" set "CONDA_BAT=%WORKSPACE_ROOT%.conda\miniconda\condabin\conda.bat"
if exist "%CONDA_PREFIX%\condabin\conda.bat" set "CONDA_BAT=%CONDA_PREFIX%\condabin\conda.bat"
if not defined CONDA_BAT if exist "%CONDA_PREFIX%\..\..\condabin\conda.bat" set "CONDA_BAT=%CONDA_PREFIX%\..\..\condabin\conda.bat"
if not defined CONDA_BAT if exist "%USERPROFILE%\.conda\condabin\conda.bat" set "CONDA_BAT=%USERPROFILE%\.conda\condabin\conda.bat"
if not defined CONDA_BAT for /f "delims=" %%C in ('where conda.bat 2^>nul') do if not defined CONDA_BAT set "CONDA_BAT=%%C"

if defined CONDA_BAT (
  call "%CONDA_BAT%" activate "%CYBERBOSS_CONDA_ENV%"
)

echo Stopping CyberBoss GenericAgent bridge processes
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference = 'SilentlyContinue'; function Stop-Tree([int]$ProcessId) { if ($ProcessId -le 0 -or $ProcessId -eq $PID) { return }; $proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue; if (-not $proc) { return }; Write-Host ('Stopping PID {0}: {1}' -f $ProcessId, $proc.ProcessName); & taskkill.exe /PID $ProcessId /T /F | Out-Host }; $stateDir = if ($env:CYBERBOSS_STATE_DIR) { $env:CYBERBOSS_STATE_DIR } else { Join-Path $PSScriptRoot 'cyberboss-data' }; foreach ($name in @('cyberboss-bridge.pid','logs/shared-wechat.pid')) { $pidFile = Join-Path $stateDir $name; $pidText = if (Test-Path -LiteralPath $pidFile) { Get-Content -LiteralPath $pidFile -Raw } else { '' }; $pidValue = 0; if ([int]::TryParse(($pidText -as [string]).Trim(), [ref]$pidValue)) { Stop-Tree $pidValue }; Remove-Item -LiteralPath $pidFile -Force }; $patterns = @('start_cyberboss_ga\.bat bridge','start_cyberboss_ga\.bat open','bin[\\/]+cyberboss\.js start','scripts[\\/]+shared-start\.js','scripts[\\/]+shared-open\.js','agentmain\.py --task cyberboss/.ga-sessions','agentmain\.py --task .*genericagent-sessions'); $targets = @(Get-CimInstance Win32_Process | Where-Object { $cmd = $_.CommandLine; $cmd -and ($patterns | Where-Object { $cmd -match $_ }) } | Sort-Object ProcessId -Descending); if ($targets.Count -gt 0) { $targets | Select-Object ProcessId,ParentProcessId,CommandLine | Format-Table -AutoSize; foreach ($p in $targets) { Stop-Tree ([int]$p.ProcessId) } } else { Write-Host 'No CyberBoss GenericAgent bridge processes found.' }; exit 0"