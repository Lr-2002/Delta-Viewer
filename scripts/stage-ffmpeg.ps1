param(
  [Parameter(Mandatory = $true)]
  [string]$Source
)

$ErrorActionPreference = "Stop"
$ResolvedSource = (Resolve-Path -LiteralPath $Source).Path
$DestinationDirectory = Join-Path $PSScriptRoot "..\src-tauri\resources\bin"
$Destination = Join-Path $DestinationDirectory "ffmpeg.exe"

New-Item -ItemType Directory -Force -Path $DestinationDirectory | Out-Null
Copy-Item -LiteralPath $ResolvedSource -Destination $Destination -Force
& $Destination -version | Select-Object -First 1
if ($LASTEXITCODE -ne 0) {
  throw "The staged FFmpeg executable did not run successfully."
}

Write-Host "Staged FFmpeg at $Destination"
