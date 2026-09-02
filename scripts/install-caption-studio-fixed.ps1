$ErrorActionPreference = 'Stop'

$Repository = 'Hatsunama/Caption-Studio'
$RequiredCommit = 'b5666c9dbf8c239c3d5660b57dfe91f942d5fb34'
$Package = 'com.hatsunama.captionstudio.fixed'
$AssetName = 'caption-studio-fixed-android.apk'
$TempDir = Join-Path $env:TEMP "CaptionStudioFixedInstaller-$PID"

function Invoke-Adb {
    param([Parameter(Mandatory)][string[]]$Arguments)

    & adb @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "ADB failed: adb $($Arguments -join ' ')"
    }
}

try {
    if (-not (Get-Command adb -ErrorAction SilentlyContinue)) {
        throw 'adb was not found. Install Android SDK Platform Tools and add it to PATH.'
    }

    $Headers = @{ Accept = 'application/vnd.github+json' }
    $Releases = @(Invoke-RestMethod -Uri "https://api.github.com/repos/$Repository/releases?per_page=100" -Headers $Headers)
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

    Invoke-Adb @('start-server')
    $Devices = @(adb devices | ForEach-Object {
        if ($_ -match '^(\S+)\s+device(?:\s|$)') { $Matches[1] }
    })
    if ($Devices.Count -eq 0) {
        throw 'No authorized Android device is ready. Unlock the phone and approve USB debugging.'
    }
    if ($Devices.Count -gt 1) {
        throw "Multiple authorized Android devices are connected: $($Devices -join ', '). Disconnect all but the intended phone."
    }

    $Serial = $Devices[0]
    if ((adb -s $Serial get-state).Trim() -ne 'device') {
        throw "Device $Serial is not ready."
    }
    if ((adb -s $Serial shell getprop sys.boot_completed).Trim() -ne '1') {
        throw "Device $Serial has not finished booting."
    }

    New-Item -ItemType Directory -Path $TempDir | Out-Null
    $Apk = Join-Path $TempDir $AssetName
    Invoke-WebRequest -Uri $Asset.browser_download_url -OutFile $Apk

    $ActualHash = (Get-FileHash -LiteralPath $Apk -Algorithm SHA256).Hash
    if ($ActualHash -ne $ExpectedHash) {
        throw 'APK checksum mismatch. Refusing installation.'
    }

    Invoke-Adb @('-s', $Serial, 'install', '-r', '--no-streaming', $Apk)
    Invoke-Adb @('-s', $Serial, 'shell', 'pm', 'enable', $Package)
    Invoke-Adb @('-s', $Serial, 'shell', 'monkey', '-p', $Package, '-c', 'android.intent.category.LAUNCHER', '1')

    adb -s $Serial shell dumpsys package $Package |
        Select-String 'versionName=|versionCode=|targetSdk='
}
finally {
    if (Test-Path -LiteralPath $TempDir) {
        Remove-Item -LiteralPath $TempDir -Recurse -Force
    }
}
