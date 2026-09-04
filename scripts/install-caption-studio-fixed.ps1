$ErrorActionPreference = 'Stop'

$Repository = 'Hatsunama/Caption-Studio'
$RequiredCommit = 'v1.4.8-fixed.1'
$Package = 'com.hatsunama.captionstudio.fixed'
$AssetName = 'caption-studio-fixed-android.apk'
$TempDir = Join-Path $env:TEMP ("CaptionStudioFixedInstaller-" + [Guid]::NewGuid().ToString('N'))
$Apk = Join-Path $TempDir $AssetName
$OwnsTempDir = $false

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

try {
    if (-not (Get-Command adb -ErrorAction SilentlyContinue)) {
        throw 'adb was not found. Install Android SDK Platform Tools and add it to PATH.'
    }

    $Headers = @{ Accept = 'application/vnd.github+json' }
    $ReleasePayload = Invoke-RestMethod `
        -Uri "https://api.github.com/repos/$Repository/releases?per_page=100" `
        -Headers $Headers
    # PowerShell 7 can preserve a JSON top-level array as one pipeline object.
    # Force element enumeration before filtering individual releases.
    $Releases = @($ReleasePayload | ForEach-Object { $_ })
    $Release = @($Releases | Where-Object {
        -not $_.draft -and
        $_.prerelease -and
        $_.tag_name -match '^v\d+\.\d+\.\d+-fixed\.\d+$' -and
        @($_.assets | Where-Object name -eq $AssetName).Count -eq 1
    } | Select-Object -First 1)
    if ($Release.Count -ne 1) {
        throw 'No published Caption Studio fixed side-by-side release was found.'
    }
    $Release = $Release[0]

    $EncodedTag = [Uri]::EscapeDataString([string]$Release.tag_name)
    $Comparison = Invoke-RestMethod `
        -Uri "https://api.github.com/repos/$Repository/compare/$RequiredCommit...$EncodedTag" `
        -Headers $Headers
    if ($Comparison.status -notin @('ahead', 'identical')) {
        throw "Release $($Release.tag_name) does not contain the integrated fixes."
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
    Invoke-WebRequest -Uri $Asset.browser_download_url -OutFile $Apk

    $ActualHash = (Get-FileHash -LiteralPath $Apk -Algorithm SHA256).Hash
    if ($ActualHash -ne $ExpectedHash) {
        throw 'APK checksum mismatch. Refusing installation.'
    }

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

    Invoke-Adb @('-s', $Serial, 'shell', 'dumpsys', 'package', $Package) |
        Select-String 'versionName=|versionCode=|targetSdk='
    Write-Host 'Update installed. Neither app was uninstalled or cleared.'
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
