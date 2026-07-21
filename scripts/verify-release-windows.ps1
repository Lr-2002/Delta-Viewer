param(
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][string]$Tag,
  [Parameter(Mandatory = $true)][ValidatePattern("^[0-9a-f]{40}$")][string]$Commit,
  [Parameter(Mandatory = $true)][ValidatePattern("^https://")][string]$WebView2Url,
  [Parameter(Mandatory = $true)][ValidatePattern("^[0-9A-Fa-f]{64}$")][string]$WebView2Sha256,
  [Parameter(Mandatory = $true)][string]$OutputDirectory
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Get-LowerSha256 {
  param([Parameter(Mandatory = $true)][string]$Path)
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Assert-Unsigned {
  param([Parameter(Mandatory = $true)][string]$Path)
  $Signature = Get-AuthenticodeSignature -LiteralPath $Path
  if ($Signature.Status -ne [System.Management.Automation.SignatureStatus]::NotSigned -or
      $null -ne $Signature.SignerCertificate) {
    throw "Unsigned release unexpectedly contains an Authenticode signature: $Path"
  }
  return $Signature
}

$RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$NsisDirectory = Join-Path $RepositoryRoot "src-tauri\target\release\bundle\nsis"
$Installers = @(Get-ChildItem -LiteralPath $NsisDirectory -File -Filter "*.exe")
if ($Installers.Count -ne 1) {
  throw "Expected exactly one NSIS installer, found $($Installers.Count)"
}
$Installer = $Installers[0]
if ($Installer.Length -lt 1000000) {
  throw "NSIS installer is implausibly small"
}

$MainBinary = Join-Path $RepositoryRoot "src-tauri\target\release\dohc-viewer.exe"
if (-not (Test-Path -LiteralPath $MainBinary -PathType Leaf)) {
  throw "Release application executable is missing: $MainBinary"
}
$InstallerSignature = Assert-Unsigned -Path $Installer.FullName
[void](Assert-Unsigned -Path $MainBinary)

$SevenZip = (Get-Command 7z.exe -ErrorAction Stop).Source
$ExtractRoot = Join-Path $env:RUNNER_TEMP ("dohc-viewer-nsis-" + [Guid]::NewGuid().ToString("N"))
$InstallRoot = Join-Path $env:RUNNER_TEMP ("dohc-viewer-install-" + [Guid]::NewGuid().ToString("N"))
$RunningApp = $null
$Uninstaller = $null
try {
  New-Item -ItemType Directory -Path $ExtractRoot | Out-Null
  & $SevenZip x -y "-o$ExtractRoot" $Installer.FullName | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "7-Zip could not extract the NSIS installer" }

  $WebViewPayloads = @(Get-ChildItem -LiteralPath $ExtractRoot -Recurse -File -Filter "MicrosoftEdgeWebView2RuntimeInstaller*.exe")
  if ($WebViewPayloads.Count -ne 1 -or $WebViewPayloads[0].Length -lt 1000000) {
    throw "NSIS does not contain exactly one offline WebView2 installer"
  }
  $WebViewSignature = Get-AuthenticodeSignature -LiteralPath $WebViewPayloads[0].FullName
  if ($WebViewSignature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or
      -not $WebViewSignature.SignerCertificate.Subject.Contains("Microsoft")) {
    throw "Embedded WebView2 installer does not have a valid Microsoft signature"
  }
  $WebViewSha = Get-LowerSha256 -Path $WebViewPayloads[0].FullName
  if ($WebViewSha -ne $WebView2Sha256.ToLowerInvariant()) {
    throw "Embedded WebView2 installer differs from the reviewed SHA-256"
  }

  $ExtractedFfmpeg = @(Get-ChildItem -LiteralPath $ExtractRoot -Recurse -File -Filter "ffmpeg.exe")
  $ExtractedManifests = @(Get-ChildItem -LiteralPath $ExtractRoot -Recurse -File -Filter "ffmpeg-manifest.json")
  $ExtractedLicenses = @(Get-ChildItem -LiteralPath $ExtractRoot -Recurse -File -Filter "FFmpeg.txt")
  if ($ExtractedFfmpeg.Count -ne 1 -or $ExtractedManifests.Count -ne 1 -or $ExtractedLicenses.Count -ne 1) {
    throw "NSIS does not contain exactly one FFmpeg binary, manifest, and license bundle"
  }
  $FfmpegManifest = Get-Content -LiteralPath $ExtractedManifests[0].FullName -Raw | ConvertFrom-Json
  if ($FfmpegManifest.platform -ne "win32-x64" -or $FfmpegManifest.portable -ne $true) {
    throw "Embedded FFmpeg manifest is not a reviewed Windows x64 portable dependency"
  }
  $FfmpegSha = Get-LowerSha256 -Path $ExtractedFfmpeg[0].FullName
  if ($FfmpegSha -ne $FfmpegManifest.sha256.ToLowerInvariant()) {
    throw "Embedded FFmpeg hash does not match its manifest"
  }
  $FfmpegLicenseSha = Get-LowerSha256 -Path $ExtractedLicenses[0].FullName
  $FfmpegManifestSha = Get-LowerSha256 -Path $ExtractedManifests[0].FullName

  $InstallProcess = Start-Process -FilePath $Installer.FullName -ArgumentList @("/S", "/D=$InstallRoot") -Wait -PassThru
  if ($InstallProcess.ExitCode -ne 0) { throw "Silent NSIS installation failed with $($InstallProcess.ExitCode)" }

  $InstalledFfmpeg = @(Get-ChildItem -LiteralPath $InstallRoot -Recurse -File -Filter "ffmpeg.exe")
  if ($InstalledFfmpeg.Count -ne 1 -or (Get-LowerSha256 -Path $InstalledFfmpeg[0].FullName) -ne $FfmpegSha) {
    throw "Installed FFmpeg resource is missing or has the wrong hash"
  }
  $InstalledApps = @(Get-ChildItem -LiteralPath $InstallRoot -Recurse -File -Filter "dohc-viewer.exe")
  if ($InstalledApps.Count -ne 1) { throw "Could not identify exactly one installed DOHC Viewer executable" }
  [void](Assert-Unsigned -Path $InstalledApps[0].FullName)

  $RunningApp = Start-Process -FilePath $InstalledApps[0].FullName -PassThru
  Start-Sleep -Seconds 8
  $RunningApp.Refresh()
  if ($RunningApp.HasExited) { throw "Installed application exited during startup smoke" }
  Stop-Process -Id $RunningApp.Id -Force
  $RunningApp.WaitForExit()
  $RunningApp = $null

  $Uninstallers = @(Get-ChildItem -LiteralPath $InstallRoot -Recurse -File -Filter "*uninstall*.exe")
  if ($Uninstallers.Count -ne 1) { throw "Could not identify exactly one NSIS uninstaller" }
  $Uninstaller = $Uninstallers[0].FullName
  [void](Assert-Unsigned -Path $Uninstaller)
  $UninstallProcess = Start-Process -FilePath $Uninstaller -ArgumentList "/S" -Wait -PassThru
  if ($UninstallProcess.ExitCode -ne 0) { throw "Silent NSIS uninstall failed with $($UninstallProcess.ExitCode)" }
  Start-Sleep -Seconds 2
  if (Test-Path -LiteralPath $InstalledApps[0].FullName) { throw "Application executable remains after uninstall" }
  $Uninstaller = $null

  New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
  $ArtifactName = "DOHC-Viewer_${Version}_UNSIGNED_windows-x64-setup.exe"
  $ArtifactPath = Join-Path $OutputDirectory $ArtifactName
  if (Test-Path -LiteralPath $ArtifactPath) { throw "Output already exists: $ArtifactPath" }
  Copy-Item -LiteralPath $Installer.FullName -Destination $ArtifactPath
  $ArtifactInfo = Get-Item -LiteralPath $ArtifactPath
  $ArtifactSha = Get-LowerSha256 -Path $ArtifactPath
  $Report = [ordered]@{
    schemaVersion = 1
    status = "passed"
    tag = $Tag
    commit = $Commit
    version = $Version
    platform = "windows"
    architecture = "x64"
    distribution = [ordered]@{
      signingMode = "unsigned"
      trustedPublisher = $false
    }
    artifact = [ordered]@{
      fileName = $ArtifactName
      sha256 = $ArtifactSha
      sizeBytes = $ArtifactInfo.Length
    }
    ffmpeg = [ordered]@{
      sha256 = $FfmpegSha
      licenseSha256 = $FfmpegLicenseSha
      manifestSha256 = $FfmpegManifestSha
      portable = $true
    }
    webview2 = [ordered]@{
      offlineInstallerVerified = $true
      sourceUrl = $WebView2Url
      sha256 = $WebViewSha
      signer = $WebViewSignature.SignerCertificate.Subject
    }
    signing = [ordered]@{
      mode = "unsigned"
      inspected = $true
      verified = $false
      authenticodeStatus = $InstallerSignature.Status.ToString()
    }
    runtimeSmoke = [ordered]@{
      passed = $true
      silentInstall = $true
      launchedSeconds = 8
      silentUninstall = $true
    }
    minimumWindowsVersion = "10.0"
  }
  $ReportPath = Join-Path $OutputDirectory "DOHC-Viewer_${Version}_windows-x64.verification.json"
  [System.IO.File]::WriteAllText(
    $ReportPath,
    (($Report | ConvertTo-Json -Depth 6) + "`n"),
    (New-Object System.Text.UTF8Encoding($false))
  )
  Write-Host "Verified unsigned Windows release artifact: $ArtifactPath"
}
finally {
  if ($RunningApp -and -not $RunningApp.HasExited) {
    Stop-Process -Id $RunningApp.Id -Force -ErrorAction SilentlyContinue
  }
  if ($Uninstaller -and (Test-Path -LiteralPath $Uninstaller)) {
    Start-Process -FilePath $Uninstaller -ArgumentList "/S" -Wait -ErrorAction SilentlyContinue | Out-Null
  }
  if (Test-Path -LiteralPath $ExtractRoot) { Remove-Item -LiteralPath $ExtractRoot -Recurse -Force }
  if (Test-Path -LiteralPath $InstallRoot) { Remove-Item -LiteralPath $InstallRoot -Recurse -Force }
}
