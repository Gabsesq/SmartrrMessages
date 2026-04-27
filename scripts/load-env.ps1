# Load project-root .env into the current PowerShell session (Process scope only).
# Usage (from repo root):  . .\scripts\load-env.ps1
# Leading dot (dot-source) is required so variables apply to your shell.

$ErrorActionPreference = "Stop"
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$envFile = Join-Path $repoRoot ".env"

if (-not (Test-Path $envFile)) {
  Write-Error "Missing file: $envFile"
}

Get-Content $envFile | ForEach-Object {
  $line = $_.Trim()
  if ($line -eq "" -or $line.StartsWith("#")) {
    return
  }
  $eq = $line.IndexOf("=")
  if ($eq -lt 1) {
    return
  }
  $key = $line.Substring(0, $eq).Trim()
  $val = $line.Substring($eq + 1).Trim()
  if (
    ($val.Length -ge 2 -and $val.StartsWith('"') -and $val.EndsWith('"')) -or
    ($val.Length -ge 2 -and $val.StartsWith("'") -and $val.EndsWith("'"))
  ) {
    $val = $val.Substring(1, $val.Length - 2)
  }
  [System.Environment]::SetEnvironmentVariable($key, $val, "Process")
}

Write-Host "Loaded .env into this PowerShell session." -ForegroundColor Green
