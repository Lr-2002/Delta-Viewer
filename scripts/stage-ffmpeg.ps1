param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$Source,

  [Parameter(Mandatory = $true)]
  [ValidatePattern("^[0-9A-Fa-f]{64}$")]
  [string]$ExpectedSha256,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string[]]$LicenseFile,

  [Parameter(Mandatory = $true)]
  [ValidatePattern("^https://")]
  [string]$SourceUrl,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$BuildId,

  [Parameter(Mandatory = $true)]
  [switch]$ReviewedPortable
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
if (-not $ReviewedPortable) {
  throw "-ReviewedPortable must explicitly attest that the Windows x64 build is portable."
}

function Get-PeMachine {
  param([Parameter(Mandatory = $true)][string]$Path)

  $Stream = [System.IO.File]::OpenRead($Path)
  $Reader = New-Object System.IO.BinaryReader($Stream)
  try {
    if ($Reader.ReadUInt16() -ne 0x5A4D) {
      throw "FFmpeg is not a PE executable."
    }
    $Stream.Position = 0x3C
    $PeOffset = $Reader.ReadUInt32()
    $Stream.Position = $PeOffset
    if ($Reader.ReadUInt32() -ne 0x00004550) {
      throw "FFmpeg has an invalid PE signature."
    }
    return $Reader.ReadUInt16()
  }
  finally {
    $Reader.Dispose()
    $Stream.Dispose()
  }
}

$ResolvedSource = (Resolve-Path -LiteralPath $Source).Path
$SourceInfo = Get-Item -LiteralPath $ResolvedSource
if ($SourceInfo.PSIsContainer -or $SourceInfo.Length -eq 0) {
  throw "FFmpeg source must be a non-empty file."
}

if ((Get-PeMachine -Path $ResolvedSource) -ne 0x8664) {
  throw "FFmpeg must be a Windows x64 executable."
}

$ExpectedSha256 = $ExpectedSha256.ToLowerInvariant()
$ActualSha256 = (Get-FileHash -LiteralPath $ResolvedSource -Algorithm SHA256).Hash.ToLowerInvariant()
if ($ActualSha256 -ne $ExpectedSha256) {
  throw "FFmpeg SHA-256 mismatch: expected $ExpectedSha256, got $ActualSha256"
}

$ResolvedLicenses = @()
foreach ($Path in $LicenseFile) {
  $Resolved = (Resolve-Path -LiteralPath $Path).Path
  $Info = Get-Item -LiteralPath $Resolved
  if ($Info.PSIsContainer -or $Info.Length -eq 0) {
    throw "License file is missing or empty: $Path"
  }
  $ResolvedLicenses += $Resolved
}
if ($ResolvedLicenses.Count -eq 0) {
  throw "At least one license file is required."
}

$VersionLines = @(& $ResolvedSource -version 2>&1 | ForEach-Object { $_.ToString() })
$VersionExitCode = $LASTEXITCODE
if ($VersionExitCode -ne 0 -or $VersionLines.Count -eq 0) {
  throw "FFmpeg did not run successfully."
}
$VersionLine = $VersionLines[0]
$ConfigurationLine = $VersionLines |
  Where-Object { $_ -like "configuration: *" } |
  Select-Object -First 1
if (-not $ConfigurationLine) {
  throw "FFmpeg did not report its build configuration."
}
$Configuration = $ConfigurationLine.Substring("configuration: ".Length)
if ($Configuration -match "(^|\s)--enable-nonfree(\s|$)") {
  throw "FFmpeg was built with --enable-nonfree and cannot be staged."
}

$EncoderLines = @(& $ResolvedSource -hide_banner -encoders 2>&1 | ForEach-Object { $_.ToString() })
$EncoderExitCode = $LASTEXITCODE
if ($EncoderExitCode -ne 0 -or -not (($EncoderLines -join "`n") -match "(?m)^\s*[A-Z.]{6}\s+mpeg4(?:\s|$)")) {
  throw "FFmpeg does not provide the required mpeg4 encoder."
}

$ResourcesDirectory = Join-Path $PSScriptRoot "..\src-tauri\resources"
$TemporaryDirectory = Join-Path $ResourcesDirectory (".ffmpeg-stage-" + [Guid]::NewGuid().ToString("N"))
$TemporaryBin = Join-Path $TemporaryDirectory "bin"
$TemporaryLicenses = Join-Path $TemporaryDirectory "licenses"
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

try {
  New-Item -ItemType Directory -Force -Path $TemporaryBin, $TemporaryLicenses | Out-Null
  $TemporaryBinary = Join-Path $TemporaryBin "ffmpeg.exe"
  $TemporaryLicense = Join-Path $TemporaryLicenses "FFmpeg.txt"
  $TemporaryManifest = Join-Path $TemporaryDirectory "ffmpeg-manifest.json"
  Copy-Item -LiteralPath $ResolvedSource -Destination $TemporaryBinary

  $LicenseText = New-Object System.Text.StringBuilder
  foreach ($ResolvedLicense in $ResolvedLicenses) {
    [void]$LicenseText.AppendLine("===== $([System.IO.Path]::GetFileName($ResolvedLicense)) =====")
    [void]$LicenseText.AppendLine()
    [void]$LicenseText.AppendLine([System.IO.File]::ReadAllText($ResolvedLicense))
    [void]$LicenseText.AppendLine()
  }
  [System.IO.File]::WriteAllText($TemporaryLicense, $LicenseText.ToString(), $Utf8NoBom)

  $StagedHash = (Get-FileHash -LiteralPath $TemporaryBinary -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($StagedHash -ne $ExpectedSha256) {
    throw "Staged FFmpeg failed SHA-256 readback."
  }

  $Manifest = [ordered]@{
    schemaVersion = 1
    platform = "win32-x64"
    binaryPath = "bin/ffmpeg.exe"
    licensePath = "licenses/FFmpeg.txt"
    sourceUrl = $SourceUrl
    buildId = $BuildId
    sha256 = $ActualSha256
    version = $VersionLine
    configuration = $Configuration
    encoder = "mpeg4"
    portable = [bool]$ReviewedPortable
    architecture = "x86_64"
    licenseFiles = @($ResolvedLicenses | ForEach-Object { [System.IO.Path]::GetFileName($_) })
    stagedAtUtc = [DateTime]::UtcNow.ToString("o")
  }
  [System.IO.File]::WriteAllText(
    $TemporaryManifest,
    (($Manifest | ConvertTo-Json -Depth 4) + "`n"),
    $Utf8NoBom
  )

  $DestinationBin = Join-Path $ResourcesDirectory "bin"
  $DestinationLicenses = Join-Path $ResourcesDirectory "licenses"
  New-Item -ItemType Directory -Force -Path $DestinationBin, $DestinationLicenses | Out-Null
  $DestinationBinary = Join-Path $DestinationBin "ffmpeg.exe"
  $DestinationLicense = Join-Path $DestinationLicenses "FFmpeg.txt"
  $DestinationManifest = Join-Path $ResourcesDirectory "ffmpeg-manifest.json"

  [System.IO.File]::Copy($TemporaryBinary, $DestinationBinary, $true)
  [System.IO.File]::Copy($TemporaryLicense, $DestinationLicense, $true)
  if ((Get-FileHash -LiteralPath $DestinationBinary -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ExpectedSha256) {
    throw "Published FFmpeg failed SHA-256 readback."
  }
  [System.IO.File]::Copy($TemporaryManifest, $DestinationManifest, $true)

  Write-Host $VersionLine
  Write-Host "Staged FFmpeg at $DestinationBinary"
  Write-Host "SHA-256: $ActualSha256"
  Write-Host "Portable: $([bool]$ReviewedPortable)"
}
finally {
  if (Test-Path -LiteralPath $TemporaryDirectory) {
    Remove-Item -LiteralPath $TemporaryDirectory -Recurse -Force
  }
}
