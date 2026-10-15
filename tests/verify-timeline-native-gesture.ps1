<#
.SYNOPSIS
Checks one native selected TimedBlock end-handle drag. Video is unsupported.
.DESCRIPTION
Requires adb on PATH and an already open, paused editor with exactly one selected
end handle matching ArtifactLabelPrefix, completely visible and unobstructed.
Does not navigate, install, change settings, or Undo. May leave ONE timing edit,
including on failure; the caller owns Undo. Whole-second playhead text cannot
verify precise no-seek behavior: a successful resize is reported UNVERIFIED.
Foreground checks bracket ADB operations but cannot atomically lock Android focus.
.EXAMPLE
./tests/verify-timeline-native-gesture.ps1 -Serial DEVICE_SERIAL -ArtifactLabelPrefix 'Hello.' -EvidenceDirectory D:\evidence -AllowEdits
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$Serial,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$ArtifactLabelPrefix,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$EvidenceDirectory,
    [Parameter(Mandatory = $true)][switch]$AllowEdits
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $AllowEdits.IsPresent) { throw 'Explicit -AllowEdits is required: this runner sends one swipe and does not Undo.' }
$adb = (Get-Command adb -CommandType Application -ErrorAction Stop).Source
$runId = [Guid]::NewGuid().ToString('N')
$runDirectory = Join-Path ([IO.Path]::GetFullPath($EvidenceDirectory)) ('timeline-native-' + $runId)
$ancestorPath = [IO.Path]::GetFullPath($EvidenceDirectory)
while ($ancestorPath) {
    if (Test-Path -LiteralPath $ancestorPath) {
        if (((Get-Item -LiteralPath $ancestorPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'Evidence directory ancestors must not be links or reparse points.'
        }
    }
    $ancestorPath = [IO.Path]::GetDirectoryName($ancestorPath)
}
$null = New-Item -ItemType Directory -Path $runDirectory
$commandLog = Join-Path $runDirectory 'adb.log'
$ownedCapturePaths = New-Object 'Collections.Generic.List[string]'
$expectedPackage = 'com.xmilo_at_your_side.caption_studio'
$culture = [Globalization.CultureInfo]::InvariantCulture
# Escape the caller's literal prefix, including punctuation such as '.' or '+'.
$handlePattern = '^' + [regex]::Escape($ArtifactLabelPrefix) +
    '(?<rest>.*?)\. Selected\. Start (?<start>\d+(?:\.\d+)?) seconds, end (?<end>\d+(?:\.\d+)?) seconds\. end$'

function Invoke-Adb {
    param([string[]]$AdbArguments)
    $lines = @(& $adb -s $Serial @AdbArguments 2>&1)
    $code = $LASTEXITCODE
    $output = ($lines | ForEach-Object { $_.ToString() }) -join "`n"
    # Never persist dumpsys output or other untrusted app/device stdout.
    Add-Content -LiteralPath $commandLog -Value ("adb -s {0} {1}`nexit={2}`n" -f $Serial, ($AdbArguments -join ' '), $code)
    if ($code -ne 0) { throw "adb $($AdbArguments -join ' ') failed (exit $code)." }
    return $output
}

function Assert-SafeTarget {
    $state = Invoke-Adb @('get-state')
    if ($state.Trim() -cne 'device') { throw 'Authorized ADB device required for the requested serial.' }
    $activity = Invoke-Adb @('shell', 'dumpsys', 'activity', 'activities')
    $resumed = [regex]::Matches($activity, '(?m)^\s*(?:mResumedActivity|topResumedActivity)\s*[:=]\s*ActivityRecord\{[^\r\n}]*?\bu\d+\s+([^\s/]+)/[^\s}]+')
    if ($resumed.Count -eq 0) { throw 'Cannot verify the exact foreground package.' }
    foreach ($entry in $resumed) {
        if ($entry.Groups[1].Value -cne $expectedPackage) { throw 'Unexpected foreground package; capture/input refused.' }
    }
}

function Invoke-GuardedAdb {
    param([string[]]$AdbArguments)
    Assert-SafeTarget
    try { $output = Invoke-Adb $AdbArguments }
    finally { Assert-SafeTarget }
    return $output
}

function Remove-OwnedCapture {
    param([string]$Path)
    $comparison = [StringComparison]::Ordinal
    if ([IO.Path]::DirectorySeparatorChar -eq '\') { $comparison = [StringComparison]::OrdinalIgnoreCase }
    $full = [IO.Path]::GetFullPath($Path)
    $run = [IO.Path]::GetFullPath($runDirectory)
    $root = [IO.Path]::GetFullPath($EvidenceDirectory)
    $registered = $false
    foreach ($owned in $ownedCapturePaths) {
        if ([string]::Equals($full, $owned, $comparison)) { $registered = $true }
    }
    if (-not $registered -or
        -not [string]::Equals([IO.Path]::GetDirectoryName($full), $run, $comparison) -or
        -not [string]::Equals([IO.Path]::GetDirectoryName($run), $root, $comparison) -or
        [IO.Path]::GetFileName($run) -cne ('timeline-native-' + $runId) -or
        [IO.Path]::GetFileName($full) -cnotmatch '^(before|after)-[a-f0-9]{32}\.(xml|png)$') {
        throw 'Refusing cleanup outside exact registered run capture paths.'
    }
    $check = $full
    while ($check) {
        if (Test-Path -LiteralPath $check) {
            $item = Get-Item -LiteralPath $check -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Refusing capture cleanup through a link or reparse point.' }
            if ($check -eq $full -and $item.PSIsContainer) { throw 'Refusing directory capture cleanup.' }
        }
        $check = [IO.Path]::GetDirectoryName($check)
    }
    if (Test-Path -LiteralPath $full) { Remove-Item -LiteralPath $full -Force }
}

function Get-Bounds {
    param([System.Xml.XmlElement]$Node)
    $match = [regex]::Match($Node.GetAttribute('bounds'), '^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$')
    if (-not $match.Success) { throw "Missing or invalid native bounds: $($Node.GetAttribute('bounds'))" }
    return [pscustomobject]@{
        Left = [int]$match.Groups[1].Value; Top = [int]$match.Groups[2].Value
        Right = [int]$match.Groups[3].Value; Bottom = [int]$match.Groups[4].Value
    }
}

function Test-OnScreen {
    param($Bounds, [int]$Width, [int]$Height)
    return ($Bounds.Left -ge 0 -and $Bounds.Top -ge 0 -and
        $Bounds.Right -le $Width -and $Bounds.Bottom -le $Height -and
        $Bounds.Right -gt $Bounds.Left -and $Bounds.Bottom -gt $Bounds.Top)
}

function Get-Snapshot {
    param([string]$Stage)
    # A new remote path AND new local path for every capture. Failed dumps are
    # never pulled or parsed, even if uiautomator incorrectly exits with zero.
    $captureId = [Guid]::NewGuid().ToString('N')
    $remoteXml = "/sdcard/timeline-native-$captureId.xml"
    $remotePng = "/sdcard/timeline-native-$captureId.png"
    $xmlPath = Join-Path $runDirectory "$Stage-$captureId.xml"
    $pngPath = Join-Path $runDirectory "$Stage-$captureId.png"
    $ownedCapturePaths.Add($xmlPath)
    $ownedCapturePaths.Add($pngPath)
    try {
        $dumpOutput = Invoke-GuardedAdb @('shell', 'uiautomator', 'dump', $remoteXml)
        if ($dumpOutput -match '(?i)error|exception|failed|failure|could not|cannot|not found|permission denied|killed|timed out' -or
            -not $dumpOutput.Contains("UI hierchary dumped to: $remoteXml")) {
            throw "Rejected $Stage uiautomator dump output (even if exit 0)."
        }
        $null = Invoke-GuardedAdb @('pull', $remoteXml, $xmlPath)
        if ((Get-Item -LiteralPath $xmlPath).Length -eq 0) { throw "Empty $Stage XML." }
        $settings = New-Object System.Xml.XmlReaderSettings
        $settings.DtdProcessing = [System.Xml.DtdProcessing]::Prohibit
        $settings.XmlResolver = $null
        $reader = [System.Xml.XmlReader]::Create($xmlPath, $settings)
        try {
            $document = New-Object System.Xml.XmlDocument
            $document.XmlResolver = $null
            $document.Load($reader)
        } finally { $reader.Dispose() }
        if ($null -eq $document.SelectSingleNode('/hierarchy/node')) { throw "Invalid $Stage UI hierarchy." }
        $packages = @($document.SelectNodes('//node[@package]'))
        if ($packages.Count -eq 0 -or $null -ne $document.SelectSingleNode('/hierarchy/node[not(@package)]')) {
            throw 'Cannot verify UI hierarchy package.'
        }
        foreach ($node in $packages) {
            if ($node.GetAttribute('package') -cne $expectedPackage) { throw 'Unexpected UI hierarchy package; captures discarded.' }
        }
        # Validate XML ownership before capturing pixels. Use pull for PS5 binary safety.
        $null = Invoke-GuardedAdb @('shell', 'screencap', '-p', $remotePng)
        $null = Invoke-GuardedAdb @('pull', $remotePng, $pngPath)
        if ((Get-Item -LiteralPath $pngPath).Length -eq 0) { throw "Empty $Stage screenshot." }
        $sizeOutput = Invoke-GuardedAdb @('shell', 'wm', 'size')
        $sizes = [regex]::Matches($sizeOutput, '(?m)(?:Physical|Override) size:\s*(\d+)x(\d+)')
        if ($sizes.Count -eq 0) { throw "Cannot determine screen size: $sizeOutput" }
        $size = $sizes[$sizes.Count - 1]
        $width = [int]$size.Groups[1].Value
        $height = [int]$size.Groups[2].Value
        $rotation = $document.DocumentElement.GetAttribute('rotation')
        if ($rotation -notmatch '^[0-3]$') { throw "Unknown UI rotation '$rotation'; cannot safely choose gesture coordinates." }
        if ($rotation -eq '1' -or $rotation -eq '3') {
            $temporary = $width; $width = $height; $height = $temporary
        }
        return [pscustomobject]@{ Document = $document; Width = $width; Height = $height; Rotation = $rotation; Xml = $xmlPath; Screenshot = $pngPath }
    } finally {
        # Exact temporary device files only. Cleanup must work after focus changes.
        try { $null = Invoke-Adb @('shell', 'rm', '-f', $remoteXml, $remotePng) }
        catch { Add-Content -LiteralPath $commandLog -Value 'Temporary capture cleanup failed.' }
    }
}

function Get-TimelineState {
    param($Snapshot)
    $handles = @($Snapshot.Document.SelectNodes('//node') | Where-Object {
        $_.GetAttribute('content-desc') -cmatch $handlePattern
    })
    if ($handles.Count -ne 1) {
        throw "TimedBlock scope only; video trim handles are unsupported. Expected exactly one selected matching end handle for literal prefix '$ArtifactLabelPrefix'; found $($handles.Count)."
    }
    $node = $handles[0]
    if ($node.GetAttribute('enabled') -eq 'false' -or $node.GetAttribute('visible-to-user') -eq 'false') {
        throw 'Selected end handle is disabled or hidden.'
    }
    $description = $node.GetAttribute('content-desc')
    $match = [regex]::Match($description, $handlePattern)
    $bounds = Get-Bounds $node
    if (-not (Test-OnScreen $bounds $Snapshot.Width $Snapshot.Height)) {
        throw "Selected end handle is off screen or clipped: $($node.GetAttribute('bounds')). Expose the complete handle before running."
    }
    # Native accessibility bounds can cover a large touch region. Require that
    # region to fit inside every ancestor as well as inside the physical screen.
    $ancestor = $node.ParentNode
    while ($ancestor -is [System.Xml.XmlElement] -and $ancestor.Name -eq 'node') {
        $parentBounds = Get-Bounds $ancestor
        if ($bounds.Left -lt $parentBounds.Left -or $bounds.Right -gt $parentBounds.Right -or
            $bounds.Top -lt $parentBounds.Top -or $bounds.Bottom -gt $parentBounds.Bottom -or
            $ancestor.GetAttribute('visible-to-user') -eq 'false') {
            throw 'Selected end handle is clipped or hidden by an ancestor. Expose the complete handle before running.'
        }
        $ancestor = $ancestor.ParentNode
    }
    $playheads = @($Snapshot.Document.SelectNodes('//node') | Where-Object {
        $_.GetAttribute('text') -match '^\d+:\d+ /' -and $_.GetAttribute('visible-to-user') -ne 'false'
    } | Where-Object {
        Test-OnScreen (Get-Bounds $_) $Snapshot.Width $Snapshot.Height
    } | ForEach-Object { $_.GetAttribute('text') } | Select-Object -Unique)
    if ($playheads.Count -ne 1) { throw "Expected one visible playhead text matching '^\d+:\d+ /'; found $($playheads.Count)." }
    return [pscustomobject]@{
        Label = $ArtifactLabelPrefix + $match.Groups['rest'].Value
        Description = $description
        Start = [decimal]::Parse($match.Groups['start'].Value, $culture)
        End = [decimal]::Parse($match.Groups['end'].Value, $culture)
        Bounds = $bounds; Playhead = $playheads[0]
        Width = $Snapshot.Width; Height = $Snapshot.Height; Rotation = $Snapshot.Rotation
        Xml = $Snapshot.Xml; Screenshot = $Snapshot.Screenshot
    }
}

$report = [ordered]@{ Serial = $Serial; Prefix = $ArtifactLabelPrefix; RunId = $runId; Scope = 'TimedBlock'; SwipeAttempted = $false; TimingResizeVerified = $false; PrecisePlayheadVerified = $false; Passed = $false }
try {
    $beforeSnapshot = Get-Snapshot 'before'
    $before = Get-TimelineState $beforeSnapshot
    $report.Before = $before
    $x = $before.Bounds.Right - 6
    $y = [int][Math]::Floor(($before.Bounds.Top + $before.Bounds.Bottom) / 2.0)
    $destinationX = $x - 60
    if ($x -lt $before.Bounds.Left -or $destinationX -lt 0) {
        throw 'Insufficient screen space for a 60 physical-pixel inward swipe from the right edge minus 6 pixels.'
    }
    $report.Gesture = [ordered]@{ FromX = $x; FromY = $y; ToX = $destinationX; ToY = $y; DurationMs = 1200 }
    $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $runDirectory 'result.json') -Encoding UTF8
    Assert-SafeTarget
    $report.SwipeAttempted = $true
    $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $runDirectory 'result.json') -Encoding UTF8
    $null = Invoke-GuardedAdb @('shell', 'input', 'swipe', "$x", "$y", "$destinationX", "$y", '1200')
    $afterSnapshot = Get-Snapshot 'after'
    $after = Get-TimelineState $afterSnapshot
    $report.After = $after
    $failures = @()
    if ($before.Label -cne $after.Label) { $failures += 'Selected item identity changed.' }
    if ($before.Width -ne $after.Width -or $before.Height -ne $after.Height -or $before.Rotation -ne $after.Rotation) { $failures += 'Screen geometry changed.' }
    if ($before.End -eq $after.End) { $failures += 'End time did not change: native end drag may have scrolled instead of resizing.' }
    elseif ($after.End -gt $before.End) { $failures += 'End time increased during an inward drag; expected a shorter item.' }
    if ($before.Start -ne $after.Start) { $failures += 'Start time changed during end resize.' }
    if ($before.Bounds.Top -ne $after.Bounds.Top -or $before.Bounds.Bottom -ne $after.Bounds.Bottom) { $failures += 'Timeline lane y bounds moved: gesture may have scrolled the lane.' }
    if ($before.Playhead -cne $after.Playhead) { $failures += "Playhead text changed: '$($before.Playhead)' -> '$($after.Playhead)'." }
    if ($failures.Count -gt 0) { throw ($failures -join ' ') }
    $report.TimingResizeVerified = $true
    $report.Limitation = 'Whole-second playhead text cannot verify precise no-seek behavior.'
    $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $runDirectory 'result.json') -Encoding UTF8
    Write-Output "UNVERIFIED: TimedBlock end $($before.End) -> $($after.End); timing resize verified, precise playhead unchanged is unverified. Evidence: $runDirectory. One timing edit remains for caller Undo."
} catch {
    $failure = $_.Exception.Message
    foreach ($capture in $ownedCapturePaths) {
        try { Remove-OwnedCapture $capture }
        catch { $failure += ' Exact owned capture cleanup failed; inspect the run directory.' }
    }
    $report.Passed = $false
    $report.Error = $failure
    $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $runDirectory 'result.json') -Encoding UTF8
    Set-Content -LiteralPath (Join-Path $runDirectory 'failure.txt') -Value $failure -Encoding UTF8
    throw "Native timeline gesture assertion failed: $failure Evidence preserved: $runDirectory. Swipe attempted: $($report.SwipeAttempted). No Undo was sent; inspect state before caller Undo."
}
