# Windows local production entry point. No signing credentials are CLI inputs.
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$UnsignedApk,
  [Parameter(Mandatory=$true)][string]$UnsignedAab,
  [Parameter(Mandatory=$true)][string]$Mapping,
  [Parameter(Mandatory=$true)][string]$Provenance,
  [Parameter(Mandatory=$true)][string]$ExpectedSourceCommit,
  [Parameter(Mandatory=$true)][string]$ExpectedRunId,
  [Parameter(Mandatory=$true)][string]$OutputDirectory,
  [Parameter(Mandatory=$true)][string]$JavaBin,
  [Parameter(Mandatory=$true)][string]$BuildTools,
  [Parameter(Mandatory=$true)][string]$Bundletool,
  [Parameter(Mandatory=$true)][string]$NodePath,
  [Parameter(Mandatory=$true)][string]$PythonPath,
  [string]$KeyRoot = 'C:\caption_studio\signing'
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$stage = $null
$ownsStage = $false
$request = $null
$locks = @()
$secrets = @()

function Assert-LocalPath([string]$Value, [bool]$Exists = $true) {
  if ($Value -notmatch '^[Cc]:\\' -or $Value -match '[:]' -and $Value.Substring(2).Contains(':')) { throw 'Only absolute local C paths are permitted.' }
  $full = [IO.Path]::GetFullPath($Value)
  if ($full -match '[ .](\\|$)') { throw 'Ambiguous path refused.' }
  $cursor = $full
  if (-not $Exists) { $cursor = [IO.Path]::GetDirectoryName($full) }
  while ($cursor) {
    $item = Get-Item -LiteralPath $cursor -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Linked path refused.' }
    $cursor = [IO.Path]::GetDirectoryName($cursor)
  }
  $drive = New-Object IO.DriveInfo('C')
  if ($drive.DriveType -ne [IO.DriveType]::Fixed) { throw 'Fixed C drive required.' }
  return $full
}
function Quote-Argument([string]$Value) {
  # Windows CommandLineToArgvW escaping, without a shell.
  return '"' + [regex]::Replace([regex]::Replace($Value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
}
function Publish-Release([string]$Stage, [string]$Output) {
  $null = Assert-LocalPath $Stage
  $null = Assert-LocalPath $Output $false
  # Directory.Move on Windows refuses any existing destination, including empty.
  [IO.Directory]::Move($Stage,$Output)
}
function Remove-OwnedStage([string]$Stage, [string]$Output) {
  $full = [IO.Path]::GetFullPath($Stage)
  $parent = [IO.Path]::GetDirectoryName($Output)
  if ([IO.Path]::GetDirectoryName($full) -cne $parent -or [IO.Path]::GetFileName($full) -notmatch '^\.local-signing-pending-[0-9a-f]{32}$') { throw 'Invalid cleanup path.' }
  $null = Assert-LocalPath $full
  Remove-Item -LiteralPath $full -Recurse -Force
}
function Invoke-PrivateTool([string]$Program, [string[]]$Arguments, [hashtable]$Passwords = @{}, [int]$TimeoutMilliseconds = 300000) {
  $info = New-Object Diagnostics.ProcessStartInfo
  $info.FileName = $Program
  $info.Arguments = (($Arguments | ForEach-Object { Quote-Argument $_ }) -join ' ')
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $info.EnvironmentVariables.Clear()
  foreach ($name in @('SystemRoot','WINDIR','TEMP','TMP')) { $info.EnvironmentVariables[$name] = [Environment]::GetEnvironmentVariable($name) }
  $info.EnvironmentVariables['PATH'] = Join-Path $env:SystemRoot 'System32'
  $process = New-Object Diagnostics.Process
  $process.StartInfo = $info
  $started = $false
  $stdout = $null; $stderr = $null
  try {
    foreach ($name in $Passwords.Keys) {
      $bstr = [IntPtr]::Zero
      try {
        $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Passwords[$name])
        $info.EnvironmentVariables[$name] = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
      } finally { if ($bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) } }
    }
    if (-not $process.Start()) { throw 'Tool start failed.' }
    $started = $true
    foreach ($name in $Passwords.Keys) { $info.EnvironmentVariables.Remove($name) }
    # Drain both pipes concurrently, including failures; never print child text.
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    $watch = [Diagnostics.Stopwatch]::StartNew()
    while (-not $process.WaitForExit(100)) {
      if ($watch.ElapsedMilliseconds -ge $TimeoutMilliseconds) { throw 'Tool timed out.' }
    }
    if (-not [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($stdout,$stderr),5000)) { throw 'Output drain timed out.' }
    $null = $stdout.GetAwaiter().GetResult()
    $null = $stderr.GetAwaiter().GetResult()
    if ($process.ExitCode -ne 0) { throw 'Tool failed.' }
  } catch { throw 'Local tool failed; output and arguments suppressed.' }
  finally {
    try {
      # The retained Process handle checks the exact child lifecycle before /PID.
      # PowerShell 5.1 has no Kill(entireProcessTree) overload.
      if ($started -and -not $process.HasExited) {
        $killInfo = New-Object Diagnostics.ProcessStartInfo
        $killInfo.FileName = Join-Path $env:SystemRoot 'System32\taskkill.exe'
        $killInfo.Arguments = '/PID '+$process.Id+' /T /F'
        $killInfo.UseShellExecute = $false
        $killInfo.CreateNoWindow = $true
        $killInfo.RedirectStandardOutput = $true
        $killInfo.RedirectStandardError = $true
        $killer = New-Object Diagnostics.Process
        $killer.StartInfo = $killInfo
        try {
          $null = $killer.Start()
          $killOut = $killer.StandardOutput.ReadToEndAsync()
          $killErr = $killer.StandardError.ReadToEndAsync()
          if (-not $killer.WaitForExit(10000)) { $killer.Kill(); throw 'Owned tree termination failed.' }
          if (-not $process.WaitForExit(10000)) { throw 'Owned child termination failed.' }
          if ($killer.ExitCode -ne 0) { throw 'Owned tree termination failed.' }
        } finally { $killer.Dispose() }
      }
      if ($null -ne $stdout -and $null -ne $stderr) {
        # Finish discarding captured text after termination, before stage cleanup.
        if (-not [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($stdout,$stderr),5000)) { throw 'Output drain timed out.' }
        $null = $stdout.GetAwaiter().GetResult()
        $null = $stderr.GetAwaiter().GetResult()
      }
    } finally {
      foreach ($name in $Passwords.Keys) { $info.EnvironmentVariables.Remove($name) }
      $info.EnvironmentVariables.Clear()
      $process.Dispose()
    }
  }
}
function Read-Password([string]$File) {
  if ((Get-Item -LiteralPath $File).Length -gt 65536) { throw 'Oversize DPAPI input.' }
  $bytes = [IO.File]::ReadAllBytes($File)
  $plain = $null
  try {
    # Accept Windows ConvertFrom-SecureString DPAPI serialization as well as
    # raw ProtectedData CurrentUser UTF-8. Neither permits an AES/plaintext key.
    $encryptedText = [Text.Encoding]::UTF8.GetString($bytes).Trim([char[]]@([char]0xFEFF,[char]32,[char]9,[char]10,[char]13))
    if ($encryptedText -match '\A01000000[0-9a-fA-F]+\z') {
      $hex = $encryptedText
      if (($hex.Length % 2) -ne 0) { throw 'Invalid DPAPI serialization.' }
      $blob = New-Object byte[] ($hex.Length / 2)
      try {
        for ($i=0; $i -lt $blob.Length; $i++) { $blob[$i] = [Convert]::ToByte($hex.Substring($i*2,2),16) }
        if ($blob.Length -lt 44 -or ([BitConverter]::ToUInt32($blob,40) -band 4) -ne 0) { throw 'CurrentUser DPAPI required.' }
      } finally { [Array]::Clear($blob,0,$blob.Length) }
      return ConvertTo-SecureString -String $encryptedText
    }
    if ($bytes.Length -lt 44 -or ([BitConverter]::ToUInt32($bytes,40) -band 4) -ne 0) { throw 'CurrentUser DPAPI required.' }
    $plain = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    $value = (New-Object Text.UTF8Encoding($false,$true)).GetString($plain)
    if ([string]::IsNullOrEmpty($value) -or $value -match '[\x00\r\n]') { throw 'Invalid password.' }
    return ConvertTo-SecureString -String $value -AsPlainText -Force
  } finally {
    [Array]::Clear($bytes,0,$bytes.Length)
    if ($null -ne $plain) { [Array]::Clear($plain,0,$plain.Length) }
    $value = $null; $encryptedText = $null; $hex = $null
  }
}

try {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Windows required.' }
  if (Test-Path Env:GITHUB_ACTIONS) { throw 'Cloud execution refused.' }
  Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
  Add-Type -AssemblyName System.Security
  $UnsignedApk = Assert-LocalPath $UnsignedApk
  $UnsignedAab = Assert-LocalPath $UnsignedAab
  $Mapping = Assert-LocalPath $Mapping
  $Provenance = Assert-LocalPath $Provenance
  $OutputDirectory = Assert-LocalPath $OutputDirectory $false
  if (Test-Path -LiteralPath $OutputDirectory) { throw 'Existing output refused.' }
  $JavaBin = Assert-LocalPath $JavaBin
  $BuildTools = Assert-LocalPath $BuildTools
  $Bundletool = Assert-LocalPath $Bundletool
  $NodePath = Assert-LocalPath $NodePath
  $PythonPath = Assert-LocalPath $PythonPath
  # Refuse output anywhere inside the key root, even before key access.
  $keyFull = [IO.Path]::GetFullPath($KeyRoot)
  if ($OutputDirectory.Equals($keyFull,[StringComparison]::OrdinalIgnoreCase) -or $OutputDirectory.StartsWith($keyFull.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase) -or $keyFull.StartsWith($OutputDirectory.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Key/output overlap refused.' }
  # Hold read-only, no-write/no-delete handles for the full transaction.
  foreach ($file in @($UnsignedApk,$UnsignedAab,$Mapping,$Provenance)) {
    $locks += [IO.File]::Open($file,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
  }
  $stage = Join-Path ([IO.Path]::GetDirectoryName($OutputDirectory)) ('.local-signing-pending-'+[Guid]::NewGuid().ToString('N'))
  $null = New-Item -ItemType Directory -Path $stage
  $ownsStage = $true
  $request = Join-Path $stage 'request.json'
  $options = @{ files=@{apk=$UnsignedApk;aab=$UnsignedAab;mapping=$Mapping;provenance=$Provenance}; output=$OutputDirectory;
    expectedCommit=$ExpectedSourceCommit;expectedRunId=$ExpectedRunId;javaBin=$JavaBin;buildTools=$BuildTools;
    bundletool=$Bundletool;python=$PythonPath;stage=$stage }
  [IO.File]::WriteAllText($request,($options | ConvertTo-Json -Depth 5),(New-Object Text.UTF8Encoding($false)))
  $validator = Join-Path $PSScriptRoot 'sign-validation.mjs'
  Invoke-PrivateTool $NodePath @('--max-old-space-size=64',$validator,'--prepare',$request)

  # Only after actual unsigned source checks do we open the local key profiles.
  $KeyRoot = Assert-LocalPath $KeyRoot
  $profiles = @(
    @{role='apk';key=(Join-Path $KeyRoot 'solana-release\key.p12');store=(Join-Path $KeyRoot 'solana-release\store-password.dpapi');pass=(Join-Path $KeyRoot 'solana-release\key-password.dpapi');aliasFile=(Join-Path $KeyRoot 'solana-release\alias.txt')},
    @{role='aab';key=(Join-Path $KeyRoot 'caption-studio-play-upload.p12');store=(Join-Path $KeyRoot 'caption-studio-play-upload.password.dpapi');pass=(Join-Path $KeyRoot 'caption-studio-play-upload.password.dpapi');aliasFile=$null}
  )
  $pins = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\..\config\local-signing-contract.json') -Raw | ConvertFrom-Json
  foreach ($profile in $profiles) {
    foreach ($file in @($profile.key,$profile.store,$profile.pass)) { $null = Assert-LocalPath $file }
    if ($profile.aliasFile) { $null = Assert-LocalPath $profile.aliasFile }
    foreach ($file in (@($profile.key,$profile.store,$profile.pass,$profile.aliasFile) | Where-Object { $_ } | Select-Object -Unique)) {
      $locks += [IO.File]::Open($file,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    }
    $storePass = Read-Password $profile.store
    $keyPass = Read-Password $profile.pass
    $secrets += $storePass; $secrets += $keyPass
    $alias = 'caption-studio-play-upload'
    if ($profile.aliasFile) { $alias = [IO.File]::ReadAllText($profile.aliasFile) }
    if ([string]::IsNullOrEmpty($alias) -or $alias -match '[\x00\r\n]' -or $alias.Length -gt 4096) { throw 'Invalid alias.' }
    $passwords = @{ CS_STORE_PASS=$storePass; CS_KEY_PASS=$keyPass }
    $der = Join-Path $stage ($profile.role+'.der')
    Invoke-PrivateTool (Join-Path $JavaBin 'keytool.exe') @('-J-Xms16m','-J-Xmx96m','-J-XX:ActiveProcessorCount=1','-exportcert','-keystore',$profile.key,'-storepass:env','CS_STORE_PASS','-alias',$alias,'-file',$der) $passwords
    $cert = New-Object Security.Cryptography.X509Certificates.X509Certificate2($der)
    try {
      if ($cert.Subject -match 'Android Debug' -or (Get-FileHash -LiteralPath $der -Algorithm SHA256).Hash.ToLowerInvariant() -cne $pins.roles.($profile.role)) { throw 'Wrong role certificate.' }
    } finally { $cert.Dispose(); Remove-Item -LiteralPath $der -Force }
    if ($profile.role -eq 'apk') {
      Invoke-PrivateTool (Join-Path $JavaBin 'java.exe') @('-Xms16m','-Xmx96m','-XX:ActiveProcessorCount=1','-jar',(Join-Path $BuildTools 'lib\apksigner.jar'),'sign','--ks',$profile.key,'--ks-key-alias',$alias,'--ks-pass','env:CS_STORE_PASS','--key-pass','env:CS_KEY_PASS','--v1-signing-enabled','false','--v2-signing-enabled','true','--v3-signing-enabled','true','--v4-signing-enabled','false',(Join-Path $stage 'caption-studio-android.apk')) $passwords
    } else {
      Invoke-PrivateTool (Join-Path $JavaBin 'jarsigner.exe') @('-J-Xms16m','-J-Xmx96m','-J-XX:ActiveProcessorCount=1','-keystore',$profile.key,'-storepass:env','CS_STORE_PASS','-keypass:env','CS_KEY_PASS','-digestalg','SHA-256','-sigalg','SHA256withRSA','-sigfile','PLAY',(Join-Path $stage 'caption-studio-play-android.aab'),$alias) $passwords
    }
    $passwords.Clear(); $storePass.Dispose(); $keyPass.Dispose()
  }
  Invoke-PrivateTool $NodePath @('--max-old-space-size=64',$validator,'--finalize',$request)
  Remove-Item -LiteralPath $request -Force
  $request = $null
  Publish-Release $stage $OutputDirectory
  $stage = $null
  Write-Output 'Local signature checks passed. Runtime verification REQUIRED; NOT store-ready.'
} catch {
  # No exception object or invocation line: aliases, tool text, credentials stay private.
  Write-Output 'Local production signing failed; no output published. Details suppressed.'
  exit 1
} finally {
  foreach ($secret in $secrets) { if ($null -ne $secret) { $secret.Dispose() } }
  foreach ($handle in $locks) { $handle.Dispose() }
  if ($ownsStage -and $null -ne $stage -and (Test-Path -LiteralPath $stage)) {
    # Only paths created by this invocation can reach this cleanup.
    Remove-OwnedStage $stage $OutputDirectory
  }
  $passwords = $null; $storePass = $null; $keyPass = $null
}
