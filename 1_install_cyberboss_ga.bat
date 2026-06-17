@echo off
setlocal EnableExtensions

cd /d "%~dp0"
echo Installing Cyberboss-for-GA...
echo If Conda is missing, a local Miniconda will be installed automatically.
echo If Git is missing, a local MinGit will be installed automatically.
echo Network sources use auto fallback unless you pass -Mirror official or -Mirror china.
echo GitHub sources use mirror-first auto fallback; pass -GithubMirror official, gh-ddlc, ghfast-top, gh-proxy, ghproxy-net, gh-llkk, github-moeyy, mirror-ghproxy, or hub-gitmirror.
echo MinGit downloads use resumable retries; pass -MinGitDownloadTimeoutSeconds or -MinGitDownloadRetries to tune.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup_scripts\setup_cyberboss_ga.ps1" %*
if errorlevel 1 (
  echo MinGit downloads use resumable retries; pass -MinGitDownloadTimeoutSeconds or -MinGitDownloadRetries to tune.
echo.
  echo Install failed. Please check the error above.
  pause
  exit /b 1
)

echo MinGit downloads use resumable retries; pass -MinGitDownloadTimeoutSeconds or -MinGitDownloadRetries to tune.
echo.
echo Install complete.
echo Next: 2_key_for_ga.bat
echo Then: 3_env_for_cyberboss.bat
echo Start with: start_cyberboss_ga.bat
echo Login with: 4_login_cyberboss_ga.bat
pause
exit /b 0

