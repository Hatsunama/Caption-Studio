$ErrorActionPreference = 'Stop'

# Trust boundary: the installer and certificate pin both come from this mutable
# repository. This checks APK consistency, not authenticity after full repository
# compromise. Fresh installs require an independently authenticated distribution
# or certificate pin to address that threat; no same-repo pin can provide it.
$ContractUri = 'https://raw.githubusercontent.com/Hatsunama/Caption-Studio/main/config/product-contract.json'
$Contract = Invoke-RestMethod -Uri $ContractUri -Headers @{ Accept = 'application/vnd.github+json' }
$Repository = [string]$Contract.repository
$VersionPattern = '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
$MinimumVersion = [string]$Contract.android.release.minimumVersion
$Package = [string]$Contract.android.release.package
$AssetName = [string]$Contract.android.release.assetName
$ExpectedCertificate = ([string]$Contract.android.release.signingCertificateSha256).ToUpperInvariant()
if ($Repository -ne 'Hatsunama/Caption-Studio' -or
    $MinimumVersion -cnotmatch $VersionPattern -or
    [string]$Contract.android.sourcePackage -cne 'com.xmilo_at_your_side.caption_studio' -or
    $Package -cne 'com.xmilo_at_your_side.caption_studio' -or
    $AssetName -notmatch '^[a-zA-Z0-9._-]+\.apk$' -or
    $ExpectedCertificate -notmatch '^[A-F0-9]{64}$') {
    throw 'The Caption Studio product contract is invalid. Refusing installation.'
}
$TempDir = Join-Path $env:TEMP ("CaptionStudioInstaller-" + [Guid]::NewGuid().ToString('N'))
$Apk = Join-Path $TempDir $AssetName
$OwnsTempDir = $false

function Compare-ReleaseVersion {
    param([string]$Left, [string]$Right)
    $LeftParts = $Left.Split('.')
    $RightParts = $Right.Split('.')
    for ($Index = 0; $Index -lt 3; $Index++) {
        # Canonical decimal components compare by length then ordinal text,
        # avoiding System.Version's Int32 limit and lexicographic 9 > 10 bugs.
        if ($LeftParts[$Index].Length -ne $RightParts[$Index].Length) {
            return $LeftParts[$Index].Length.CompareTo($RightParts[$Index].Length)
        }
        $Order = [string]::CompareOrdinal($LeftParts[$Index], $RightParts[$Index])
        if ($Order -ne 0) { return $Order }
    }
    return 0
}

function Invoke-Adb {
    param([Parameter(Mandatory)][string[]]$Arguments)

    # Windows PowerShell 5.1 wraps native stderr (including normal ADB
    # progress) in ErrorRecords. Capture it without terminating early;
    # native exit status, not the stream used, decides success.
    $PreviousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $PSNativeCommandUseErrorActionPreference = $false
        $Output = @(& adb @Arguments 2>&1 | ForEach-Object { $_.ToString() })
        $ExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $PreviousPreference
    }
    if ($ExitCode -ne 0) {
        throw "ADB failed (exit $ExitCode). No uninstall or data clearing was attempted.`n$($Output -join [Environment]::NewLine)"
    }
    $Output
}

function Invoke-AssetDownload {
    param(
        [Parameter(Mandatory)][string]$Uri,
        [Parameter(Mandatory)][string]$Destination
    )

    $Attempts = 4
    $Partial = "$Destination.partial"
    for ($Attempt = 1; $Attempt -le $Attempts; $Attempt++) {
        try {
            if (Test-Path -LiteralPath $Partial) {
                Remove-Item -LiteralPath $Partial -Force -ErrorAction Stop
            }
            Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $Partial -ErrorAction Stop
            if (-not (Test-Path -LiteralPath $Partial)) {
                throw 'The download completed without creating an APK file.'
            }
            [IO.File]::Move($Partial, $Destination)
            return
        }
        catch {
            try {
                if (Test-Path -LiteralPath $Partial) {
                    Remove-Item -LiteralPath $Partial -Force -ErrorAction Stop
                }
            }
            catch {
                Write-Warning "Could not remove interrupted download ${Partial}: $($_.Exception.Message)"
            }
            if ($Attempt -eq $Attempts) {
                throw "APK download failed after $Attempts attempts: $($_.Exception.Message)"
            }
            Write-Warning "Download interrupted. Retrying attempt $($Attempt + 1) of $Attempts in $($Attempt * 3) seconds."
            Start-Sleep -Seconds ($Attempt * 3)
        }
    }
}

function Get-FileSha256 {
    param([Parameter(Mandatory)][string]$Path)

    if (Get-Command Get-FileHash -ErrorAction SilentlyContinue) {
        return ([string](Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash).ToUpperInvariant()
    }

    $Algorithm = [Security.Cryptography.SHA256]::Create()
    $Stream = $null
    try {
        $Stream = [IO.File]::OpenRead($Path)
        return ([BitConverter]::ToString($Algorithm.ComputeHash($Stream))).Replace('-', '')
    }
    finally {
        if ($null -ne $Stream) { $Stream.Dispose() }
        $Algorithm.Dispose()
    }
}

function Resolve-ApkSigner {
    foreach ($Name in @('apksigner.bat', 'apksigner')) {
        $Command = Get-Command $Name -ErrorAction SilentlyContinue
        if ($Command) { return $Command.Source }
    }
    $AdbCommand = Get-Command adb -ErrorAction SilentlyContinue
    if (-not $AdbCommand) { return $null }
    $SdkRoot = Split-Path -Parent (Split-Path -Parent $AdbCommand.Source)
    $BuildTools = Join-Path $SdkRoot 'build-tools'
    if (-not (Test-Path -LiteralPath $BuildTools -PathType Container)) { return $null }
    foreach ($Directory in @(Get-ChildItem -LiteralPath $BuildTools -Directory | Sort-Object {
        try { [Version]$_.Name } catch { [Version]'0.0' }
    } -Descending)) {
        $Candidate = Join-Path $Directory.FullName 'apksigner.bat'
        if (Test-Path -LiteralPath $Candidate -PathType Leaf) { return $Candidate }
    }
    $null
}

function Get-ApkPackage {
    param(
        [Parameter(Mandatory)][string]$ApkSigner,
        [Parameter(Mandatory)][string]$ApkPath,
        [Parameter(Mandatory)][string]$ExpectedVersion
    )
    $BuildToolsDirectory = Split-Path -Parent $ApkSigner
    $Aapt = $null
    foreach ($Name in @('aapt2.exe', 'aapt.exe', 'aapt2', 'aapt')) {
        $Candidate = Join-Path $BuildToolsDirectory $Name
        if (Test-Path -LiteralPath $Candidate -PathType Leaf) {
            $Aapt = $Candidate
            break
        }
        $Command = Get-Command $Name -ErrorAction SilentlyContinue
        if ($Command) { $Aapt = $Command.Source; break }
    }
    if (-not $Aapt) { throw 'Android SDK Build Tools with aapt2 or aapt are required to verify the APK package.' }
    $PreviousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $PSNativeCommandUseErrorActionPreference = $false
        $Output = @(& $Aapt dump badging $ApkPath 2>&1 | ForEach-Object { $_.ToString() })
        $ExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $PreviousPreference
    }
    if ($ExitCode -ne 0) { throw 'Cannot read APK package metadata. Refusing installation.' }
    $PackageLines = @($Output | Where-Object { $_ -cmatch "^package: name='([^']+)'" })
    if ($PackageLines.Count -ne 1) { throw 'APK package metadata is missing or ambiguous. Refusing installation.' }
    $VersionMatch = [regex]::Match($PackageLines[0], "^package: name='[^']+' versionCode='([1-9][0-9]{0,9})' versionName='([^']+)'(?:\s|$)")
    if (-not $VersionMatch.Success) {
        throw 'APK version metadata is missing or invalid. Refusing installation.'
    }
    if ([long]$VersionMatch.Groups[1].Value -gt 2100000000 -or
        $VersionMatch.Groups[2].Value -cnotmatch $VersionPattern -or
        $VersionMatch.Groups[2].Value -cne $ExpectedVersion) {
        throw 'APK version does not match the selected release or has an invalid versionCode. Refusing installation.'
    }
    [regex]::Match($PackageLines[0], "^package: name='([^']+)'").Groups[1].Value
}

function Get-ApkCertificateSha256 {
    param(
        [Parameter(Mandatory)][string]$ApkSigner,
        [Parameter(Mandatory)][string]$ApkPath
    )
    $PreviousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $PSNativeCommandUseErrorActionPreference = $false
        $Output = @(& $ApkSigner verify --print-certs $ApkPath 2>&1 | ForEach-Object { $_.ToString() })
        $ExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $PreviousPreference
    }
    if ($ExitCode -ne 0) { throw 'The downloaded APK signature is invalid. Refusing installation.' }
    $Line = @($Output | Where-Object { $_ -match 'certificate SHA-256 digest:' } | Select-Object -First 1)
    if ($Line.Count -ne 1) { throw 'The downloaded APK signing certificate could not be verified.' }
    $CertificateMatch = [regex]::Match([string]$Line[0], 'certificate SHA-256 digest:\s*([A-Fa-f0-9:]{64,95})')
    if (-not $CertificateMatch.Success) { throw 'The downloaded APK signing certificate could not be verified.' }
    ($CertificateMatch.Groups[1].Value -replace ':', '').ToUpperInvariant()
}

try {
    if (-not (Get-Command adb -ErrorAction SilentlyContinue)) {
        throw 'adb was not found. Install Android SDK Platform Tools and add it to PATH.'
    }
    $ApkSigner = Resolve-ApkSigner
    if (-not $ApkSigner) {
        throw 'Android SDK Build Tools with apksigner are required to verify the APK signing certificate.'
    }

    $Headers = @{ Accept = 'application/vnd.github+json' }
    $Release = $null
    $ReleaseVersionText = $null
    $Page = 1
    do {
        $ReleasePayload = Invoke-RestMethod `
            -Uri "https://api.github.com/repos/$Repository/releases?per_page=100&page=$Page" `
            -Headers $Headers
        # Explicit enumeration also handles PowerShell 7 top-level JSON arrays.
        $Releases = @($ReleasePayload | ForEach-Object { $_ })
        foreach ($Candidate in $Releases) {
            $Tag = [string]$Candidate.tag_name
            if ($Candidate.draft -or -not $Tag.StartsWith('v')) { continue }
            $CandidateVersion = $Tag.Substring(1)
            if ($CandidateVersion -cnotmatch $VersionPattern -or
                @($Candidate.assets | Where-Object name -eq $AssetName).Count -ne 1) { continue }
            if ((Compare-ReleaseVersion $CandidateVersion $MinimumVersion) -lt 0) { continue }
            # Both published prereleases and promoted stable releases can carry
            # the compatible APK; API ordering is not semantic version ordering.
            if ($null -eq $Release -or
                (Compare-ReleaseVersion $CandidateVersion $ReleaseVersionText) -gt 0) {
                $Release = $Candidate
                $ReleaseVersionText = $CandidateVersion
            }
        }
        $Page++
    } while ($Releases.Count -eq 100)
    if ($null -eq $Release) {
        throw "No published compatible Caption Studio Android release at or above $MinimumVersion was found."
    }

    $Asset = @($Release.assets | Where-Object name -eq $AssetName)[0]
    $ExpectedHash = ([string]$Asset.digest -replace '^sha256:', '').ToUpperInvariant()
    if ($ExpectedHash -notmatch '^[A-F0-9]{64}$') {
        throw "Release $($Release.tag_name) does not provide a valid APK SHA-256 digest."
    }

    Invoke-Adb @('start-server') | Out-Host
    $Devices = @(Invoke-Adb @('devices') | ForEach-Object {
        if ($_ -match '^(\S+)\s+(device|unauthorized|offline)(?:\s|$)') {
            [PSCustomObject]@{ Serial = $Matches[1]; State = $Matches[2] }
        }
    })
    if ($Devices.Count -eq 0) {
        throw 'No authorized Android device is ready. Unlock the phone and approve USB debugging.'
    }
    if ($Devices.Count -gt 1) {
        throw "Multiple Android devices are connected: $($Devices.Serial -join ', '). Disconnect all but the intended phone."
    }

    $Serial = $Devices[0].Serial
    if ($Devices[0].State -ne 'device') {
        throw "Device $Serial is $($Devices[0].State). Unlock the phone and approve USB debugging, then retry."
    }
    if ((Invoke-Adb @('-s', $Serial, 'get-state') | Out-String).Trim() -ne 'device') {
        throw "Device $Serial is not ready."
    }
    if ((Invoke-Adb @('-s', $Serial, 'shell', 'getprop', 'sys.boot_completed') | Out-String).Trim() -ne '1') {
        throw "Device $Serial has not finished booting."
    }

    New-Item -ItemType Directory -Path $TempDir | Out-Null
    $OwnsTempDir = $true
    Write-Host "Device: $Serial. Downloading $($Release.tag_name)..."
    Invoke-AssetDownload -Uri $Asset.browser_download_url -Destination $Apk

    $ActualHash = Get-FileSha256 -Path $Apk
    if ($ActualHash -ne $ExpectedHash) {
        throw 'APK checksum mismatch. Refusing installation.'
    }
    $ActualCertificate = Get-ApkCertificateSha256 -ApkSigner $ApkSigner -ApkPath $Apk
    if ($ActualCertificate -ne $ExpectedCertificate) {
        throw 'APK signing certificate mismatch. Refusing installation.'
    }

    $ActualPackage = Get-ApkPackage -ApkSigner $ApkSigner -ApkPath $Apk -ExpectedVersion $ReleaseVersionText
    if ($ActualPackage -cne $Package) {
        throw "APK package mismatch: expected $Package, found $ActualPackage. Refusing installation."
    }
    Write-Host "Installing $Package. Older package IDs keep their own apps and projects; no data is migrated."
    $InstallOutput = @(Invoke-Adb @('-s', $Serial, 'install', '-r', '--no-streaming', $Apk))
    $InstallOutput | Out-Host
    if (-not ($InstallOutput | Where-Object { $_.Trim() -eq 'Success' })) {
        throw 'ADB did not confirm installation success. No uninstall or data clearing was attempted.'
    }
    Invoke-Adb @('-s', $Serial, 'shell', 'pm', 'enable', $Package) | Out-Host
    $LaunchOutput = @(
        Invoke-Adb @('-s', $Serial, 'shell', 'cmd', 'package', 'resolve-activity', '--brief',
            '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', $Package)
    )
    $LaunchComponent = ([string]($LaunchOutput | Select-Object -Last 1)).Trim()
    if ($LaunchComponent -notmatch "^$([regex]::Escape($Package))/") {
        throw "Resolved launcher activity does not belong to ${Package}: $LaunchComponent"
    }
    Invoke-Adb @('-s', $Serial, 'shell', 'am', 'start', '-W', '-n', $LaunchComponent) | Out-Host

    $PackageInfo = @(Invoke-Adb @('-s', $Serial, 'shell', 'dumpsys', 'package', $Package))
    $PackageInfo | Select-String 'versionName=|versionCode=|targetSdk='
    $InstalledVersion = @($PackageInfo | Where-Object { $_ -match '^\s*versionName=(\S+)' } | ForEach-Object { $Matches[1] } | Select-Object -First 1)
    if ($InstalledVersion.Count -ne 1 -or $InstalledVersion[0] -ne $ReleaseVersionText) {
        throw "Installed package version does not match release $($Release.tag_name). No app data was cleared."
    }
    Write-Host 'Caption Studio installed or updated under its expected package ID. Existing apps and their separate project storage were preserved.'
}
finally {
    if ($OwnsTempDir) {
        try {
            if (Test-Path -LiteralPath $Apk) {
                Remove-Item -LiteralPath $Apk -Force -ErrorAction Stop
            }
            # Delete only our empty directory, never a recursive tree.
            [IO.Directory]::Delete($TempDir, $false)
            Write-Host 'Temporary APK and installer download directory removed.'
        }
        catch {
            Write-Warning "Temporary cleanup failed at ${TempDir}: $($_.Exception.Message)"
        }
    }
}
