param(
  [string]$EnvPath = ".conda\env",
  [string]$PythonVersion = "3.11",
  [string]$NodeVersion = "22",
  [switch]$InstallMiniconda,
  [switch]$NoAutoMiniconda,
  [ValidateSet("auto", "official", "china")]
  [string]$Mirror = "auto",
  [ValidateSet("auto", "official", "gh-ddlc", "ghfast-top", "gh-proxy", "mirror-ghproxy", "ghproxy-net", "gh-llkk", "github-moeyy", "hub-gitmirror")]
  [string]$GithubMirror = "auto",
  [int]$NetworkTimeoutSeconds = 30,
  [int]$MinGitDownloadTimeoutSeconds = 900,
  [int]$MinGitDownloadRetries = 3,
  [string]$MinicondaDir = ".conda\miniconda"
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir
$GaDir = Join-Path $RepoRoot "GenericAgent-main"
$CyberbossDir = Join-Path $RepoRoot "cyberboss-main"
$ToolsRoot = Join-Path $RepoRoot ".tools"
$LocalGitRoot = Join-Path $ToolsRoot "mingit"
$LocalCondaRoot = Join-Path $RepoRoot ".conda"
$TempRoot = Join-Path $RepoRoot ".temp"
$DownloadsDir = Join-Path $TempRoot "downloads"
$PipCacheDir = Join-Path $TempRoot "pip-cache"
$NpmCacheDir = Join-Path $TempRoot "npm-cache"
$CondaPkgsDir = Join-Path $TempRoot "conda-pkgs"
$ProcessTempDir = Join-Path $TempRoot "process"
$EnvExample = Join-Path $RepoRoot ".env.example"
$CyberbossEnv = Join-Path $CyberbossDir ".env"
$ConfigScript = Join-Path $ScriptDir "configure_cyberboss_ga.ps1"
$InsightTemplate = Join-Path $GaDir "assets\cyberboss_global_mem_insight_template.txt"
$MemoryTemplate = Join-Path $GaDir "assets\cyberboss_global_mem_template.txt"
$InsightFile = Join-Path $GaDir "memory\global_mem_insight.txt"
$MemoryFile = Join-Path $GaDir "memory\global_mem.txt"

$SourceProfiles = [ordered]@{
  official = @{
    Label = "official"
    MinicondaUrl = "https://repo.anaconda.com/miniconda/Miniconda3-latest-Windows-x86_64.exe"
    CondaChannel = "conda-forge"
    PipIndexUrl = "https://pypi.org/simple"
    NpmRegistry = "https://registry.npmjs.org/"
  }
  china = @{
    Label = "china"
    MinicondaUrl = "https://mirrors.tuna.tsinghua.edu.cn/anaconda/miniconda/Miniconda3-latest-Windows-x86_64.exe"
    CondaChannel = "https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud/conda-forge"
    PipIndexUrl = "https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple"
    NpmRegistry = "https://registry.npmmirror.com/"
  }
}

$GithubSourceProfiles = [ordered]@{
  official = @{
    Label = "official"
    UrlPrefix = ""
  }
  # Same default GitHub mirror prefix used by Fwind43/GenericAgent-Admin.
  "gh-proxy" = @{
    Label = "gh-proxy"
    UrlPrefix = "https://gh-proxy.com/"
  }
  "mirror-ghproxy" = @{
    Label = "mirror-ghproxy"
    UrlPrefix = "https://mirror.ghproxy.com/"
  }
  "gh-ddlc" = @{
    Label = "gh-ddlc"
    UrlPrefix = "https://gh.ddlc.top/"
  }
  "ghfast-top" = @{
    Label = "ghfast-top"
    UrlPrefix = "https://ghfast.top/"
  }
  "ghproxy-net" = @{
    Label = "ghproxy-net"
    UrlPrefix = "https://ghproxy.net/"
  }
  "gh-llkk" = @{
    Label = "gh-llkk"
    UrlPrefix = "https://gh.llkk.cc/"
  }
  "github-moeyy" = @{
    Label = "github-moeyy"
    UrlPrefix = "https://github.moeyy.xyz/"
  }
  "hub-gitmirror" = @{
    Label = "hub-gitmirror"
    UrlPrefix = "https://hub.gitmirror.com/"
  }
}

if ($NetworkTimeoutSeconds -lt 5) {
  throw "NetworkTimeoutSeconds must be at least 5."
}
if ($MinGitDownloadTimeoutSeconds -lt 60) {
  throw "MinGitDownloadTimeoutSeconds must be at least 60."
}
if ($MinGitDownloadRetries -lt 1) {
  throw "MinGitDownloadRetries must be at least 1."
}

function Resolve-RepoPath([string]$Path) {
  if ([System.IO.Path]::IsPathRooted($Path)) {
    return [System.IO.Path]::GetFullPath($Path)
  }
  return [System.IO.Path]::GetFullPath((Join-Path $RepoRoot $Path))
}

$EnvPrefix = Resolve-RepoPath $EnvPath
$MinicondaDir = Resolve-RepoPath $MinicondaDir
$AllowAutoMiniconda = (-not $NoAutoMiniconda) -or $InstallMiniconda

function Initialize-LocalInstallState {
  foreach ($path in @($ToolsRoot, $LocalCondaRoot, $TempRoot, $DownloadsDir, $PipCacheDir, $NpmCacheDir, $CondaPkgsDir, $ProcessTempDir)) {
    New-Item -ItemType Directory -Path $path -Force | Out-Null
  }
  $env:PIP_CACHE_DIR = $PipCacheDir
  $env:npm_config_cache = $NpmCacheDir
  $env:CONDA_PKGS_DIRS = $CondaPkgsDir
  $env:TEMP = $ProcessTempDir
  $env:TMP = $ProcessTempDir
}

function Assert-FreeSpace([string]$Path, [int]$MinGb = 4) {
  $root = [System.IO.Path]::GetPathRoot([System.IO.Path]::GetFullPath($Path))
  $driveName = $root.Substring(0, 1)
  $drive = Get-PSDrive -Name $driveName -ErrorAction Stop
  $minBytes = [int64]$MinGb * 1GB
  if ($drive.Free -lt $minBytes) {
    $freeGb = [math]::Round($drive.Free / 1GB, 2)
    throw "Not enough free space on $root. Need at least ${MinGb}GB, available ${freeGb}GB."
  }
}

function Get-SourceOrder {
  if ($Mirror -eq "official") { return @("official") }
  if ($Mirror -eq "china") { return @("china") }
  return @("official", "china")
}

function Get-GithubSourceOrder {
  if ($GithubMirror -ne "auto") { return @($GithubMirror) }
  # Prefer mirrors in auto mode. GenericAgent-Admin uses gh-proxy as the default GitHub mirror.
  return @("gh-ddlc", "ghproxy-net", "gh-proxy", "ghfast-top", "gh-llkk", "official", "mirror-ghproxy", "github-moeyy", "hub-gitmirror")
}

function Invoke-WithSourceFallback([string]$Description, [scriptblock]$Action) {
  $errors = New-Object System.Collections.Generic.List[string]
  $sources = @(Get-SourceOrder)
  for ($index = 0; $index -lt $sources.Count; $index++) {
    $sourceName = $sources[$index]
    $profile = $SourceProfiles[$sourceName]
    Write-Host ""
    Write-Host ("{0} using {1} source (network timeout {2}s)" -f $Description, $sourceName, $NetworkTimeoutSeconds)
    try {
      & $Action $sourceName $profile
      return
    } catch {
      $message = $_.Exception.Message
      [void]$errors.Add(("{0}: {1}" -f $sourceName, $message))
      if ($index -lt ($sources.Count - 1)) {
        Write-Host ("{0} failed on {1}; switching to {2} source." -f $Description, $sourceName, $sources[$index + 1])
      }
    }
  }
  throw ("{0} failed on all configured sources:`n{1}" -f $Description, ($errors -join "`n"))
}

function Invoke-WithGithubFallback([string]$Description, [scriptblock]$Action) {
  $errors = New-Object System.Collections.Generic.List[string]
  $sources = @(Get-GithubSourceOrder)
  for ($index = 0; $index -lt $sources.Count; $index++) {
    $sourceName = $sources[$index]
    $profile = $GithubSourceProfiles[$sourceName]
    Write-Host ""
    Write-Host ("{0} using GitHub source {1} (network timeout {2}s)" -f $Description, $sourceName, $NetworkTimeoutSeconds)
    try {
      & $Action $sourceName $profile
      return
    } catch {
      $message = $_.Exception.Message
      [void]$errors.Add(("{0}: {1}" -f $sourceName, $message))
      if ($index -lt ($sources.Count - 1)) {
        Write-Host ("{0} failed on {1}; switching to {2} GitHub source." -f $Description, $sourceName, $sources[$index + 1])
      }
    }
  }
  throw ("{0} failed on all configured GitHub sources:`n{1}" -f $Description, ($errors -join "`n"))
}

function Convert-GithubUrlForSource([string]$Url, [string]$SourceName) {
  $text = [string]$Url
  $source = [string]$SourceName
  if ([string]::IsNullOrWhiteSpace($text) -or $source -eq "official") {
    return $text
  }
  $prefix = [string]$GithubSourceProfiles[$source].UrlPrefix
  if ([string]::IsNullOrWhiteSpace($prefix)) {
    return $text
  }
  if ($text.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    return $text
  }
  return $prefix + $text
}

function Invoke-DownloadFileWithHardTimeout([string]$Url, [string]$OutFile, [int]$TimeoutSeconds, [switch]$Resume) {
  $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
  if ($curl) {
    $connectTimeout = [Math]::Min(30, [Math]::Max(5, $TimeoutSeconds))
    $maxTime = [Math]::Max(10, $TimeoutSeconds)
    $args = @(
      "--location",
      "--fail",
      "--show-error",
      "--connect-timeout", [string]$connectTimeout,
      "--max-time", [string]$maxTime,
      "--retry", "0",
      "--user-agent", "Cyberboss-for-GA-Setup",
      "--output", $OutFile
    )
    if ($Resume -and (Test-Path -LiteralPath $OutFile) -and ((Get-Item -LiteralPath $OutFile).Length -gt 0)) {
      $args = @("--continue-at", "-") + $args
    }
    & $curl.Source @args $Url
    if ($LASTEXITCODE -ne 0) {
      throw "curl failed with exit code $LASTEXITCODE"
    }
    return
  }

  Invoke-WebRequest -Uri $Url -OutFile $OutFile -TimeoutSec $TimeoutSeconds -UseBasicParsing -Headers @{
    "User-Agent" = "Cyberboss-for-GA-Setup"
  }
}

function Test-ZipArchive([string]$Path) {
  try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue
    $zip = [System.IO.Compression.ZipFile]::OpenRead($Path)
    $zip.Dispose()
    return $true
  } catch {
    return $false
  }
}

function Invoke-Native([string]$FilePath, [string[]]$Arguments, [string]$Description) {
  Write-Host $Description
  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Description failed with exit code $LASTEXITCODE"
  }
}

function Invoke-CondaRun([string[]]$Arguments, [string]$Description) {
  Invoke-Native $script:CondaBat (@("run", "-p", $script:EnvPrefix) + $Arguments) $Description
}

function Set-CondaNetworkTimeoutEnv {
  $env:CONDA_REMOTE_CONNECT_TIMEOUT_SECS = [string]$NetworkTimeoutSeconds
  $env:CONDA_REMOTE_READ_TIMEOUT_SECS = [string]$NetworkTimeoutSeconds
  $env:CONDA_REMOTE_MAX_RETRIES = "1"
}

function Find-CondaBat {
  $candidates = New-Object System.Collections.Generic.List[string]
  $candidates.Add((Join-Path $MinicondaDir "condabin\conda.bat"))
  if ($env:CONDA_PREFIX) { $candidates.Add((Join-Path $env:CONDA_PREFIX "condabin\conda.bat")) }
  if ($env:USERPROFILE) {
    $candidates.Add((Join-Path $env:USERPROFILE "miniconda3\condabin\conda.bat"))
    $candidates.Add((Join-Path $env:USERPROFILE "anaconda3\condabin\conda.bat"))
    $candidates.Add((Join-Path $env:USERPROFILE ".conda\condabin\conda.bat"))
  }

  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }

  $cmd = Get-Command conda.bat -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

function Find-GitExe {
  $localGit = Join-Path $LocalGitRoot "cmd\git.exe"
  if (Test-Path -LiteralPath $localGit) {
    return (Resolve-Path -LiteralPath $localGit).Path
  }
  $cmd = Get-Command git.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $cmd = Get-Command git -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

function Add-GitToPath([string]$GitExe) {
  if ([string]::IsNullOrWhiteSpace($GitExe)) { return }
  $gitCmdDir = Split-Path -Parent $GitExe
  if ([string]::IsNullOrWhiteSpace($gitCmdDir)) { return }
  $pathParts = @($env:PATH -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  if (-not ($pathParts | Where-Object { $_ -ieq $gitCmdDir })) {
    $env:PATH = $gitCmdDir + ";" + $env:PATH
  }
}

function Get-MinGitAssetPattern {
  $arch = (($env:PROCESSOR_ARCHITECTURE, $env:PROCESSOR_ARCHITEW6432) -join " ").ToLowerInvariant()
  if ($arch -match "arm64|aarch64") {
    return "^MinGit-.*-arm64\.zip$"
  }
  return "^MinGit-.*-64-bit\.zip$"
}

function Resolve-MinGitAssetUrl([string]$GithubSourceName) {
  $apiUrl = Convert-GithubUrlForSource "https://api.github.com/repos/git-for-windows/git/releases/latest" $GithubSourceName
  Write-Host "Resolving MinGit release from $apiUrl"
  $response = Invoke-WebRequest -Uri $apiUrl -TimeoutSec $NetworkTimeoutSeconds -UseBasicParsing -Headers @{
    "User-Agent" = "Cyberboss-for-GA-Setup"
    "Accept" = "application/vnd.github+json, application/json"
  }
  $release = $response.Content | ConvertFrom-Json
  $pattern = Get-MinGitAssetPattern
  $assets = @($release.assets | Where-Object { $_.name -match $pattern })
  if ($assets.Count -lt 1) {
    throw "Could not find MinGit asset matching $pattern in latest Git for Windows release."
  }
  $asset = $assets | Select-Object -First 1
  $url = [string]$asset.browser_download_url
  if ([string]::IsNullOrWhiteSpace($url)) {
    throw "MinGit asset has no browser_download_url."
  }
  return $url
}

function Resolve-MinGitAssetUrlWithFallback {
  $errors = New-Object System.Collections.Generic.List[string]
  foreach ($sourceName in @(Get-GithubSourceOrder)) {
    try {
      return (Resolve-MinGitAssetUrl $sourceName)
    } catch {
      [void]$errors.Add(("{0}: {1}" -f $sourceName, $_.Exception.Message))
    }
  }

  $arch = (($env:PROCESSOR_ARCHITECTURE, $env:PROCESSOR_ARCHITEW6432) -join " ").ToLowerInvariant()
  if ($arch -match "arm64|aarch64") {
    Write-Host "Could not resolve latest MinGit release; using known ARM64 fallback URL."
    return "https://github.com/git-for-windows/git/releases/download/v2.54.0.windows.1/MinGit-2.54.0-arm64.zip"
  }

  Write-Host "Could not resolve latest MinGit release; using known x64 fallback URL."
  return "https://github.com/git-for-windows/git/releases/download/v2.54.0.windows.1/MinGit-2.54.0-64-bit.zip"
}

function Download-MinGitArchiveWithFallback([string]$AssetUrl) {
  $errors = New-Object System.Collections.Generic.List[string]
  foreach ($sourceName in @(Get-GithubSourceOrder)) {
    $downloadUrl = Convert-GithubUrlForSource $AssetUrl $sourceName
    $safeSourceName = $sourceName -replace '[^A-Za-z0-9_.-]', '_'
    $zipPath = Join-Path $DownloadsDir ("MinGit-latest.{0}.zip" -f $safeSourceName)
    $tmpPath = Join-Path $DownloadsDir ("MinGit-latest.{0}.tmp" -f $safeSourceName)
    Remove-Item -LiteralPath $tmpPath -Force -ErrorAction SilentlyContinue
    try {
      for ($attempt = 1; $attempt -le $MinGitDownloadRetries; $attempt++) {
        try {
          Write-Host ("Downloading MinGit from {0} (attempt {1}/{2}, timeout {3}s)" -f $downloadUrl, $attempt, $MinGitDownloadRetries, $MinGitDownloadTimeoutSeconds)
          Invoke-DownloadFileWithHardTimeout $downloadUrl $tmpPath $MinGitDownloadTimeoutSeconds -Resume
          if (-not (Test-Path -LiteralPath $tmpPath) -or ((Get-Item -LiteralPath $tmpPath).Length -lt 5MB)) {
            throw "Downloaded MinGit archive is missing or too small."
          }
          if (-not (Test-ZipArchive $tmpPath)) {
            throw "Downloaded MinGit archive is not a valid zip file."
          }
          Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
          Move-Item -LiteralPath $tmpPath -Destination $zipPath -Force
          return $zipPath
        } catch {
          $message = $_.Exception.Message
          [void]$errors.Add(("{0} attempt {1}: {2}" -f $sourceName, $attempt, $message))
          if ($attempt -lt $MinGitDownloadRetries) {
            Write-Host ("MinGit download failed on {0} attempt {1}; retrying with resume." -f $sourceName, $attempt)
            Start-Sleep -Seconds 2
          } else {
            Write-Host ("MinGit download failed on {0}; trying next GitHub source." -f $sourceName)
          }
        }
      }
    } finally {
      Remove-Item -LiteralPath $tmpPath -Force -ErrorAction SilentlyContinue
    }
  }
  throw ("Downloading portable Git (MinGit) failed on all configured GitHub sources:`n{0}" -f ($errors -join "`n"))
}
function Install-MinGitIfNeeded {
  $gitExe = Find-GitExe
  if ($gitExe) {
    Add-GitToPath $gitExe
    Write-Host "Using git: $gitExe"
    return $gitExe
  }

  $assetUrl = Resolve-MinGitAssetUrlWithFallback
  $zipPath = Download-MinGitArchiveWithFallback $assetUrl

  if (Test-Path -LiteralPath $LocalGitRoot) {
    Remove-Item -LiteralPath $LocalGitRoot -Recurse -Force
  }
  New-Item -ItemType Directory -Path $LocalGitRoot -Force | Out-Null
  Expand-Archive -LiteralPath $zipPath -DestinationPath $LocalGitRoot -Force

  $gitExe = Join-Path $LocalGitRoot "cmd\git.exe"
  if (-not (Test-Path -LiteralPath $gitExe)) {
    throw "MinGit was extracted, but git.exe was not found at $gitExe"
  }
  Add-GitToPath $gitExe
  Write-Host "Installed local MinGit: $gitExe"
  return (Resolve-Path -LiteralPath $gitExe).Path
}

function Install-MinicondaIfNeeded {
  if (-not $AllowAutoMiniconda) {
    throw "Conda was not found. Re-run without -NoAutoMiniconda, or install Miniconda/Anaconda first."
  }

  $condaBat = Join-Path $MinicondaDir "condabin\conda.bat"
  if (Test-Path -LiteralPath $condaBat) {
    return (Resolve-Path -LiteralPath $condaBat).Path
  }

  $installer = Join-Path $DownloadsDir "Miniconda3-latest-Windows-x86_64.exe"
  Invoke-WithSourceFallback "Downloading Miniconda" {
    param($sourceName, $profile)
    if (Test-Path -LiteralPath $installer) {
      Remove-Item -LiteralPath $installer -Force
    }
    Write-Host ("Downloading from {0}" -f $profile.MinicondaUrl)
    Invoke-WebRequest -Uri $profile.MinicondaUrl -OutFile $installer -TimeoutSec $NetworkTimeoutSeconds -UseBasicParsing
    if (-not (Test-Path -LiteralPath $installer) -or ((Get-Item -LiteralPath $installer).Length -lt 1MB)) {
      throw "Downloaded Miniconda installer is missing or too small."
    }
  }

  Write-Host "Installing Miniconda to $MinicondaDir"
  $installProcess = Start-Process -FilePath $installer -Wait -PassThru -ArgumentList @(
    "/S",
    "/InstallationType=JustMe",
    "/RegisterPython=0",
    "/AddToPath=0",
    "/D=$MinicondaDir"
  )
  if ($installProcess.ExitCode -ne 0) {
    throw "Miniconda installer failed with exit code $($installProcess.ExitCode)."
  }

  if (-not (Test-Path -LiteralPath $condaBat)) {
    throw "Miniconda installation finished, but conda.bat was not found at $condaBat"
  }
  return (Resolve-Path -LiteralPath $condaBat).Path
}

function Test-CondaPrefixExists([string]$Prefix) {
  Test-Path -LiteralPath (Join-Path $Prefix "python.exe")
}

function Remove-PartialEnvPrefix {
  if (-not (Test-Path -LiteralPath $script:EnvPrefix)) { return }
  $repoFull = [System.IO.Path]::GetFullPath($RepoRoot).TrimEnd('\')
  $envFull = [System.IO.Path]::GetFullPath($script:EnvPrefix).TrimEnd('\')
  if ($envFull.StartsWith($repoFull + "\", [System.StringComparison]::OrdinalIgnoreCase)) {
    Write-Host "Removing partial conda env: $script:EnvPrefix"
    Remove-Item -LiteralPath $script:EnvPrefix -Recurse -Force
  } else {
    Write-Host "Partial env cleanup skipped for path outside repo: $script:EnvPrefix"
  }
}

function New-CondaEnvWithFallback {
  Invoke-WithSourceFallback "Creating local conda env with Python $PythonVersion, Node.js $NodeVersion, and pip" {
    param($sourceName, $profile)
    Remove-PartialEnvPrefix
    Set-CondaNetworkTimeoutEnv
    Invoke-Native $script:CondaBat @(
      "create",
      "-p", $script:EnvPrefix,
      "-y",
      "--override-channels",
      "-c", $profile.CondaChannel,
      "python=$PythonVersion",
      "nodejs=$NodeVersion",
      "pip",
      "setuptools",
      "wheel"
    ) ("Creating local conda env via {0}" -f $sourceName)
  }
}

function Test-PipAvailable {
  & $script:CondaBat @("run", "-p", $script:EnvPrefix, "python", "-m", "pip", "--version") *> $null
  return ($LASTEXITCODE -eq 0)
}

function Ensure-PipBootstrapWithFallback {
  if (Test-PipAvailable) {
    Write-Host "pip is available in local conda env."
    return
  }

  Write-Host "pip is missing in local conda env; installing pip bootstrap tooling with conda."
  Invoke-WithSourceFallback "Installing pip bootstrap tooling" {
    param($sourceName, $profile)
    Set-CondaNetworkTimeoutEnv
    Invoke-Native $script:CondaBat @(
      "install",
      "-p", $script:EnvPrefix,
      "-y",
      "--override-channels",
      "-c", $profile.CondaChannel,
      "pip",
      "setuptools",
      "wheel"
    ) ("Installing pip bootstrap tooling via {0}" -f $sourceName)
  }

  if (-not (Test-PipAvailable)) {
    throw "pip bootstrap tooling was installed, but python -m pip is still unavailable."
  }
}

function Invoke-PipInstallWithFallback([string[]]$PipArguments, [string]$Description) {
  Invoke-WithSourceFallback $Description {
    param($sourceName, $profile)
    $args = @(
      "python", "-m", "pip"
    ) + $PipArguments + @(
      "--timeout", [string]$NetworkTimeoutSeconds,
      "--retries", "1",
      "-i", $profile.PipIndexUrl
    )
    Invoke-CondaRun $args ("{0} via {1}" -f $Description, $sourceName)
  }
}

function Invoke-WithGitHubRewrite([string]$GithubSourceName, [scriptblock]$Action) {
  $oldCount = $env:GIT_CONFIG_COUNT
  $oldKey0 = $env:GIT_CONFIG_KEY_0
  $oldValue0 = $env:GIT_CONFIG_VALUE_0
  $oldPrompt = $env:GIT_TERMINAL_PROMPT
  try {
    $env:GIT_TERMINAL_PROMPT = "0"
    if ($GithubSourceName -ne "official") {
      $rewriteBase = Convert-GithubUrlForSource "https://github.com/" $GithubSourceName
      $env:GIT_CONFIG_COUNT = "1"
      $env:GIT_CONFIG_KEY_0 = "url.$rewriteBase.insteadOf"
      $env:GIT_CONFIG_VALUE_0 = "https://github.com/"
      Write-Host "GitHub URL rewrite: https://github.com/ -> $rewriteBase"
    }
    & $Action
  } finally {
    if ($null -eq $oldCount) { Remove-Item Env:\GIT_CONFIG_COUNT -ErrorAction SilentlyContinue } else { $env:GIT_CONFIG_COUNT = $oldCount }
    if ($null -eq $oldKey0) { Remove-Item Env:\GIT_CONFIG_KEY_0 -ErrorAction SilentlyContinue } else { $env:GIT_CONFIG_KEY_0 = $oldKey0 }
    if ($null -eq $oldValue0) { Remove-Item Env:\GIT_CONFIG_VALUE_0 -ErrorAction SilentlyContinue } else { $env:GIT_CONFIG_VALUE_0 = $oldValue0 }
    if ($null -eq $oldPrompt) { Remove-Item Env:\GIT_TERMINAL_PROMPT -ErrorAction SilentlyContinue } else { $env:GIT_TERMINAL_PROMPT = $oldPrompt }
  }
}

function Invoke-NpmInstallWithFallback {
  Install-MinGitIfNeeded | Out-Null
  Push-Location $CyberbossDir
  try {
    Invoke-WithSourceFallback "Installing CyberBoss Node dependencies" {
      param($npmSourceName, $npmProfile)
      $npmRegistry = [string]$npmProfile.NpmRegistry
      if ([string]::IsNullOrWhiteSpace($npmRegistry)) {
        throw "npm registry URL is empty for source $npmSourceName."
      }
      Invoke-WithGithubFallback ("Installing CyberBoss GitHub dependencies with npm registry {0}" -f $npmSourceName) {
        param($githubSourceName, $githubProfile)
        Invoke-WithGitHubRewrite $githubSourceName {
          $timeoutMs = [string]($NetworkTimeoutSeconds * 1000)
          Invoke-CondaRun @(
            "npm", "install",
            "--cache", $NpmCacheDir,
            "--registry", $npmRegistry,
            "--fetch-timeout", $timeoutMs,
            "--fetch-retries", "1",
            "--fetch-retry-mintimeout", "1000",
            "--fetch-retry-maxtimeout", $timeoutMs
          ) ("Installing CyberBoss Node dependencies via npm {0}, GitHub {1}" -f $npmSourceName, $githubSourceName)
        }
      }
    }
  } finally {
    Pop-Location
  }
}

function Set-EnvFileValue([string]$Path, [string]$Key, [string]$Value) {
  $lines = @()
  if (Test-Path -LiteralPath $Path) {
    $lines = @(Get-Content -LiteralPath $Path -Encoding UTF8)
  }

  $found = $false
  $updated = New-Object 'System.Collections.Generic.List[string]'
  foreach ($line in $lines) {
    if ($line -match "^\s*$([regex]::Escape($Key))\s*=") {
      $found = $true
      [void]$updated.Add("$Key=$Value")
    } else {
      [void]$updated.Add($line)
    }
  }

  if (-not $found) {
    [void]$updated.Add("$Key=$Value")
  }

  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllLines($Path, $updated.ToArray(), $utf8NoBom)
}

function Seed-InitialMemoryFile([string]$Path, [string]$TemplatePath, [string]$DefaultContent) {
  if (-not (Test-Path -LiteralPath $TemplatePath)) { return }
  $shouldWrite = -not (Test-Path -LiteralPath $Path)
  if (-not $shouldWrite) {
    $current = (Get-Content -LiteralPath $Path -Raw -Encoding UTF8).Trim()
    if ($current -eq $DefaultContent.Trim()) {
      $shouldWrite = $true
    }
  }
  if ($shouldWrite) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $Path) -Force | Out-Null
    Copy-Item -LiteralPath $TemplatePath -Destination $Path -Force
    Write-Host "Seeded initial memory: $Path"
  } else {
    Write-Host "Existing memory kept: $Path"
  }
}

if (-not (Test-Path -LiteralPath $GaDir)) { throw "Missing GenericAgent-main: $GaDir" }
if (-not (Test-Path -LiteralPath $CyberbossDir)) { throw "Missing cyberboss-main: $CyberbossDir" }

Initialize-LocalInstallState
Assert-FreeSpace $RepoRoot 4

Write-Host "Installing CyberBoss for GenericAgent"
Write-Host "Mirror mode: $Mirror"
Write-Host "GitHub mirror mode: $GithubMirror"
Write-Host "Network timeout: ${NetworkTimeoutSeconds}s"; Write-Host "MinGit download timeout: ${MinGitDownloadTimeoutSeconds}s"; Write-Host "MinGit download retries: $MinGitDownloadRetries"
Write-Host "Auto Miniconda install: $AllowAutoMiniconda"

$script:EnvPrefix = $EnvPrefix
$script:CondaBat = Find-CondaBat
if (-not $script:CondaBat) {
  $script:CondaBat = Install-MinicondaIfNeeded
}

Write-Host "Using conda: $script:CondaBat"
Write-Host "Using local env: $script:EnvPrefix"
Write-Host "Using local temp: $TempRoot"

if (-not (Test-CondaPrefixExists $script:EnvPrefix)) {
  New-CondaEnvWithFallback
} else {
  Write-Host "Local conda env already exists: $script:EnvPrefix"
}

Ensure-PipBootstrapWithFallback
Invoke-PipInstallWithFallback @("install", "--upgrade", "pip", "setuptools", "wheel") "Upgrading pip tooling"
Invoke-PipInstallWithFallback @("install", $GaDir) "Installing GenericAgent package and dependencies"
Invoke-NpmInstallWithFallback

if (Test-Path -LiteralPath $ConfigScript) {
  & $ConfigScript -PathOnly -EnvPath $script:EnvPrefix
} else {
  if (-not (Test-Path -LiteralPath $CyberbossEnv) -and (Test-Path -LiteralPath $EnvExample)) {
    Copy-Item -LiteralPath $EnvExample -Destination $CyberbossEnv
    Write-Host "Created cyberboss-main\.env from .env.example"
    Write-Host "Fill CYBERBOSS_ACCOUNT_ID after logging in or selecting an account."
  }
  if (Test-Path -LiteralPath $CyberbossEnv) {
    Set-EnvFileValue $CyberbossEnv "CYBERBOSS_CONDA_ENV" $script:EnvPrefix
  }
}

Seed-InitialMemoryFile $InsightFile $InsightTemplate ""
Seed-InitialMemoryFile $MemoryFile $MemoryTemplate "# [Global Memory - L2]"

Write-Host ""
Write-Host "Setup complete."
Write-Host "Start with: .\start_cyberboss_ga.bat"
Write-Host "Stop with:  .\stop_cyberboss_ga.bat"

