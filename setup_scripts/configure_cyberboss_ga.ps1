param(
  [switch]$Interactive,
  [switch]$PathOnly,
  [string]$EnvPath = ".conda\env"
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir
$CyberbossDir = Join-Path $RepoRoot "cyberboss-main"
$GaDir = Join-Path $RepoRoot "GenericAgent-main"
$StateDir = Join-Path $RepoRoot "cyberboss-data"
$EnvExample = Join-Path $RepoRoot ".env.example"
$CyberbossEnv = Join-Path $CyberbossDir ".env"

function Resolve-RepoPath([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) { return "" }
  if ([System.IO.Path]::IsPathRooted($Path)) {
    return [System.IO.Path]::GetFullPath($Path)
  }
  return [System.IO.Path]::GetFullPath((Join-Path $RepoRoot $Path))
}

function Ensure-EnvFile {
  if (-not (Test-Path -LiteralPath $CyberbossDir)) {
    throw "Missing cyberboss-main: $CyberbossDir"
  }
  if (-not (Test-Path -LiteralPath $CyberbossEnv)) {
    if (Test-Path -LiteralPath $EnvExample) {
      Copy-Item -LiteralPath $EnvExample -Destination $CyberbossEnv
    } else {
      $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
      [System.IO.File]::WriteAllText($CyberbossEnv, "", $utf8NoBom)
    }
  }
}

function Get-EnvFileValue([string]$Key) {
  if (-not (Test-Path -LiteralPath $CyberbossEnv)) { return "" }
  foreach ($line in Get-Content -LiteralPath $CyberbossEnv -Encoding UTF8) {
    if ($line -match "^\s*$([regex]::Escape($Key))\s*=(.*)$") {
      return $Matches[1].Trim()
    }
  }
  return ""
}

function Set-EnvFileValue([string]$Key, [string]$Value) {
  $lines = @()
  if (Test-Path -LiteralPath $CyberbossEnv) {
    $lines = @(Get-Content -LiteralPath $CyberbossEnv -Encoding UTF8)
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
  [System.IO.File]::WriteAllLines($CyberbossEnv, $updated.ToArray(), $utf8NoBom)
}

function Set-DefaultEnvValue([string]$Key, [string]$Value) {
  if ([string]::IsNullOrWhiteSpace((Get-EnvFileValue $Key))) {
    Set-EnvFileValue $Key $Value
  }
}

function Prompt-EnvValue([string]$Key, [string]$Label) {
  $current = Get-EnvFileValue $Key
  $prompt = $Label
  if (-not [string]::IsNullOrWhiteSpace($current)) {
    $prompt = "$Label [$current]"
  }
  $value = Read-Host $prompt
  if (-not [string]::IsNullOrWhiteSpace($value)) {
    Set-EnvFileValue $Key $value.Trim()
  }
}

function Prompt-HelpLanguage {
  $current = Get-EnvFileValue "CYBERBOSS_HELP_ZH"
  if ([string]::IsNullOrWhiteSpace($current)) {
    $current = "zh"
  } elseif ($current -in @("1", "true", "yes", "on")) {
    $current = "zh"
  } elseif ($current -in @("0", "false", "no", "off")) {
    $current = "en"
  }

  while ($true) {
    $value = Read-Host "/help language (zh/en) [$current]"
    if ([string]::IsNullOrWhiteSpace($value)) {
      Set-EnvFileValue "CYBERBOSS_HELP_ZH" $current
      return
    }

    $normalized = $value.Trim().ToLowerInvariant()
    if ($normalized -in @("zh", "zh-cn", "cn", "chinese")) {
      Set-EnvFileValue "CYBERBOSS_HELP_ZH" "zh"
      return
    }
    if ($normalized -in @("en", "en-us", "english")) {
      Set-EnvFileValue "CYBERBOSS_HELP_ZH" "en"
      return
    }
    Write-Host "Please enter zh or en."
  }
}

Ensure-EnvFile
New-Item -ItemType Directory -Path $StateDir -Force | Out-Null

$repoFull = [System.IO.Path]::GetFullPath($RepoRoot)
$envPrefix = Resolve-RepoPath $EnvPath

$pathValues = [ordered]@{
  CYBERBOSS_WORKSPACE_ROOT = $repoFull
  CYBERBOSS_HOME = [System.IO.Path]::GetFullPath($CyberbossDir)
  CYBERBOSS_STATE_DIR = [System.IO.Path]::GetFullPath($StateDir)
  CYBERBOSS_CONDA_ENV = $envPrefix
  CYBERBOSS_GA_AGENTMAIN = [System.IO.Path]::GetFullPath((Join-Path $GaDir "agentmain.py"))
  CYBERBOSS_GA_TASK_DIR = [System.IO.Path]::GetFullPath((Join-Path $StateDir "genericagent-sessions"))
  TIMELINE_FOR_AGENT_STATE_DIR = [System.IO.Path]::GetFullPath($StateDir)
}

foreach ($entry in $pathValues.GetEnumerator()) {
  Set-EnvFileValue $entry.Key $entry.Value
}

Set-DefaultEnvValue "CYBERBOSS_RUNTIME" "genericagent"
Set-DefaultEnvValue "CYBERBOSS_ACCOUNT_ID" ""
Set-DefaultEnvValue "CYBERBOSS_BOT_NAME" "CyberBoss"
Set-DefaultEnvValue "CYBERBOSS_HELP_ZH" "zh"
Set-DefaultEnvValue "CYBERBOSS_GA_LLM_NO" "1"
Set-DefaultEnvValue "TIMELINE_FOR_AGENT_LOCALE" "zh-CN"
Set-DefaultEnvValue "CYBERBOSS_SHARED_PORT" "8765"
Set-DefaultEnvValue "CYBERBOSS_CODEX_ENDPOINT" "ws://127.0.0.1:8765"
Set-DefaultEnvValue "CYBERBOSS_TIMELINE_UI_THEME" "default"

if ($Interactive) {
  Write-Host ""
  Write-Host "Configure CyberBoss personalization. Press Enter to keep existing values."
  Write-Host "Timeline UI theme options: default (neutral), neko (cute). Press Enter to keep the current/default value."
  Prompt-EnvValue "CYBERBOSS_USER_NAME" "User name"
  Prompt-EnvValue "CYBERBOSS_USER_GENDER" "User gender (female/male/other)"
  Prompt-EnvValue "CYBERBOSS_BOT_NAME" "Bot name"
  Prompt-HelpLanguage
  Prompt-EnvValue "TIMELINE_FOR_AGENT_LOCALE" "Timeline locale (zh-CN/en-US)"
  Prompt-EnvValue "CYBERBOSS_TIMELINE_UI_THEME" "Timeline UI theme (default/neko)"
}

Write-Host "CyberBoss env ready: $CyberbossEnv"
