param(
  [string]$ApiKey,
  [switch]$Force
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir
$GaDir = Join-Path $RepoRoot "GenericAgent-main"
$Template = Join-Path $GaDir "mykey_cyberboss_template.py"
$MyKey = Join-Path $GaDir "mykey.py"

if (-not (Test-Path -LiteralPath $Template)) {
  throw "Missing key template: $Template"
}

if ((Test-Path -LiteralPath $MyKey) -and -not $Force) {
  $answer = Read-Host "GenericAgent-main\mykey.py already exists. Overwrite? (y/N)"
  if ($answer -notin @("y", "Y", "yes", "YES")) {
    Write-Host "Kept existing GenericAgent-main\mykey.py"
    exit 0
  }
}

if ([string]::IsNullOrWhiteSpace($ApiKey)) {
  $secure = Read-Host "Paste API key" -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    $ApiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  } finally {
    if ($bstr -ne [IntPtr]::Zero) {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
  }
}

if ([string]::IsNullOrWhiteSpace($ApiKey)) {
  throw "API key is empty."
}

$keyForPython = $ApiKey.Replace("\", "\\").Replace("'", "\'")
$text = Get-Content -LiteralPath $Template -Raw -Encoding UTF8
$text = [regex]::Replace(
  $text,
  "('apikey'\s*:\s*')([^']*)(')",
  { param($match) $match.Groups[1].Value + $keyForPython + $match.Groups[3].Value }
)

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($MyKey, $text, $utf8NoBom)
Write-Host "Wrote GenericAgent-main\mykey.py"