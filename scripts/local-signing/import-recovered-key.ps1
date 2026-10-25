# Windows PowerShell 5.1, Java 17, Node 22, OpenSSL 3. No production pin override.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$Envelope,
    [Parameter(Mandatory=$true)][string]$Manifest,
    [Parameter(Mandatory=$true)][string]$RecipientCertificate,
    [Parameter(Mandatory=$true)][string]$RecipientPrivatePem,
    [Parameter(Mandatory=$true)][string]$RecipientPasswordDpapi,
    [Parameter(Mandatory=$true)][string]$ApprovedExporterSha256,
    [Parameter(Mandatory=$true)][string]$JdkBin,
    [Parameter(Mandatory=$true)][string]$OpenSslExe,
    [Parameter(Mandatory=$true)][string]$NodeExe,
    [Parameter(Mandatory=$true)][string]$DestinationRoot
)

function Assert-Path([string]$Path, [bool]$Directory = $false) {
    if (-not [IO.Path]::IsPathRooted($Path) -or $Path -notmatch '^[Cc]:\\' -or $Path -match '(^|[\\/])\.\.?([\\/]|$)' -or $Path.Substring(2).Contains(':')) { throw 'Invalid path' }
    $full = [IO.Path]::GetFullPath($Path)
    if ($full.TrimEnd('\') -cne $Path.TrimEnd('\')) { throw 'Noncanonical path' }
    $item = Get-Item -LiteralPath $full -Force -ErrorAction Stop
    if ([bool]$item.PSIsContainer -ne $Directory) { throw 'Wrong path type' }
    while ($null -ne $item) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse point' }
        if ($item.PSIsContainer) { $item = $item.Parent } else { $item = $item.Directory }
    }
    return $full
}

function Assert-PrivateDirectory([string]$Path) {
    $null = Assert-Path $Path $true
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = [IO.Directory]::GetAccessControl($Path)
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or -not $acl.AreAccessRulesProtected) { throw 'Unsafe owner or inheritance' }
    $full = $false
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow) {
            if ($rule.IdentityReference.Value -ne $sid.Value) { throw 'Unsafe ACL' }
            if (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl) { $full = $true }
        }
    }
    if (-not $full) { throw 'Missing owner access' }
}

function New-PrivateStage([string]$Root) {
    $null = Assert-Path $Root $true
    $path = Join-Path $Root ('import-' + [Guid]::NewGuid().ToString('N'))
    if (Test-Path -LiteralPath $path) { throw 'Stage exists' }
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetOwner($sid)
    $acl.SetAccessRuleProtection($true, $false)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
    # Random unguessable name; ACL is applied by CreateDirectory, never after creation.
    [IO.Directory]::CreateDirectory($path, $acl) | Out-Null
    Assert-PrivateDirectory $path
    return $path
}

function Assert-Tree([string]$Path) {
    $null = Assert-Path $Path $true
    foreach ($entry in Get-ChildItem -LiteralPath $Path -Force) {
        if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Unsafe cleanup tree' }
        if ($entry.PSIsContainer) { Assert-Tree $entry.FullName }
    }
}

function Remove-OwnedStage([string]$Stage, [string]$Root) {
    if (-not $Stage -or -not [IO.Directory]::Exists($Stage)) { return }
    if ([IO.Path]::GetDirectoryName($Stage) -cne $Root.TrimEnd('\') -or [IO.Path]::GetFileName($Stage) -cnotmatch '^import-[a-f0-9]{32}$') { throw 'Unowned cleanup path' }
    Assert-PrivateDirectory $Stage
    Assert-Tree $Stage
    Remove-Item -LiteralPath $Stage -Recurse -Force -ErrorAction Stop
}

function Invoke-Captured([string]$Exe, [string[]]$Arguments, [hashtable]$Environment = @{}) {
    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = $Exe
    $quoted = foreach ($arg in $Arguments) {
        if ($arg.Contains([char]0)) { throw 'Invalid argument' }
        '"' + [regex]::Replace([regex]::Replace($arg, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
    }
    $psi.Arguments = $quoted -join ' '
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.RedirectStandardInput = $true
    $psi.EnvironmentVariables.Clear()
    foreach ($name in @('SystemRoot','WINDIR','TEMP','TMP')) {
        $value = [Environment]::GetEnvironmentVariable($name)
        if ($value) { $psi.EnvironmentVariables[$name] = $value }
    }
    $psi.EnvironmentVariables['OPENSSL_CONF'] = 'NUL'
    foreach ($name in $Environment.Keys) { $psi.EnvironmentVariables[$name] = $Environment[$name] }
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $psi
    try {
        if (-not $process.Start()) { throw 'Child failed' }
        $process.StandardInput.Close()
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(60000)) { throw 'Child timed out' }
        $process.WaitForExit()
        if ($process.ExitCode -ne 0) { throw 'Child failed' }
        return $stdout.GetAwaiter().GetResult()
    } finally {
        try { if ($process.Id -and -not $process.HasExited) { $process.Kill(); $process.WaitForExit() } } catch { }
        $psi.EnvironmentVariables.Clear()
        $psi.Arguments = ''
        $Environment = $null
        $process.Dispose()
    }
}

function Read-Password([string]$Path) {
    # Raw CurrentUser DPAPI over UTF-8, or PowerShell ConvertFrom-SecureString
    # without a key (its existing CurrentUser DPAPI hex serialization).
    $secure = $null; $ptr = [IntPtr]::Zero
    try {
        if ((Get-Item -LiteralPath $Path).Length -gt 65536) { throw 'Oversize DPAPI input' }
        Add-Type -AssemblyName System.Security
        $blob = [IO.File]::ReadAllBytes($Path)
        if ($blob.Length -ge 4 -and $blob[0] -eq 1 -and $blob[1] -eq 0 -and $blob[2] -eq 0 -and $blob[3] -eq 0) {
            return ,([Security.Cryptography.ProtectedData]::Unprotect($blob, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser))
        }
        Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security') -ErrorAction Stop
        $secure = ConvertTo-SecureString ([IO.File]::ReadAllText($Path))
        $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
        return ,([Text.UTF8Encoding]::new($false, $true).GetBytes($plain))
    } finally {
        $plain = $null
        if ($ptr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
        if ($null -ne $secure) { $secure.Dispose() }
    }
}

function Save-Password([string]$Path, [byte[]]$Bytes) {
    Add-Type -AssemblyName System.Security
    $protected = $null
    try {
        $protected = [Security.Cryptography.ProtectedData]::Protect($Bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
        $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
        try { $stream.Write($protected, 0, $protected.Length) } finally { $stream.Dispose() }
    } finally {
        if ($null -ne $protected) { [Array]::Clear($protected, 0, $protected.Length) }
    }
}

function Get-CertificateHash([string]$Text) {
    $matches = [regex]::Matches($Text, '-----BEGIN CERTIFICATE-----\s*([A-Za-z0-9+/=\s]+?)-----END CERTIFICATE-----')
    if ($matches.Count -ne 1 -or ([regex]::Matches($Text, '-----BEGIN CERTIFICATE-----')).Count -ne 1) { throw 'Ambiguous certificate' }
    $der = [Convert]::FromBase64String($matches[0].Groups[1].Value)
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hash.ComputeHash($der))).Replace('-', '').ToLowerInvariant() } finally { $hash.Dispose() }
}

function Prove-Key([string]$Stage, [string]$Jdk, [string]$StorePassword, [string]$KeyPassword, [string]$Alias, [string]$Expected) {
    $jar = Join-Path $Stage 'proof.jar'
    $j = @('-J-Xms16m','-J-Xmx64m','-J-XX:ActiveProcessorCount=1','-J-Duser.language=en','-J-Duser.country=US')
    try {
        Add-Type -AssemblyName System.IO.Compression
        $stream = [IO.File]::Open($jar, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite)
        try {
            $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $true)
            try {
                $entry = $archive.CreateEntry('synthetic-proof.txt')
                $out = $entry.Open()
                try { $bytes = [Text.Encoding]::ASCII.GetBytes('Caption Studio disposable signing proof'); $out.Write($bytes,0,$bytes.Length) } finally { $out.Dispose() }
            } finally { $archive.Dispose() }
        } finally { $stream.Dispose() }
        $null = Invoke-Captured (Join-Path $Jdk 'jarsigner.exe') ($j + @('-keystore',(Join-Path $Stage 'key.p12'),'-storepass:env','IMPORT_STORE','-keypass:env','IMPORT_KEY',$jar,$Alias)) @{ IMPORT_STORE = $StorePassword; IMPORT_KEY = $KeyPassword }
        $verified = Invoke-Captured (Join-Path $Jdk 'jarsigner.exe') ($j + @('-verify',$jar))
        if ($verified -notmatch '(?m)^jar verified\.\s*$') { throw 'Signature not verified' }
        # This certificate comes from the successfully verified signed JAR, not a store listing.
        $cert = Invoke-Captured (Join-Path $Jdk 'keytool.exe') ($j + @('-printcert','-rfc','-jarfile',$jar))
        $actual = Get-CertificateHash $cert
        if ($actual -cne $Expected) { throw 'Wrong private signing key' }
        return $actual
    } finally {
        if ([IO.File]::Exists($jar)) { [IO.File]::Delete($jar) }
        $StorePassword = $null; $KeyPassword = $null; $Alias = $null; $cert = $null; $verified = $null
    }
}

function Publish-Bundle([string]$Stage, [string]$Destination) {
    Assert-PrivateDirectory $Stage
    Assert-Tree $Stage
    # Same-volume atomic rename; Directory.Move refuses an existing destination.
    [IO.Directory]::Move($Stage, $Destination)
}

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$stage = $null; $recipientBytes = $null; $storeBytes = $null; $keyBytes = $null
$recipientPassword = $null; $storePassword = $null; $keyPassword = $null; $alias = $null
$ok = $false
try {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Windows required' }
    $null = Assert-Path $DestinationRoot $true
    Assert-PrivateDirectory $DestinationRoot
    $DestinationRoot = $DestinationRoot.TrimEnd('\')
    $final = Join-Path $DestinationRoot 'solana-release'
    if (Test-Path -LiteralPath $final) { throw 'Destination exists' }
    foreach ($path in @($Envelope,$Manifest,$RecipientCertificate,$RecipientPrivatePem,$RecipientPasswordDpapi,$OpenSslExe,$NodeExe)) { $null = Assert-Path $path }
    $null = Assert-Path $JdkBin $true
    foreach ($name in @('java.exe','keytool.exe','jarsigner.exe')) { $null = Assert-Path (Join-Path $JdkBin $name) }
    $helper = Join-Path $PSScriptRoot 'import-validation.mjs'
    $null = Assert-Path $helper
    $version = Invoke-Captured (Join-Path $JdkBin 'java.exe') @('-Xms16m','-Xmx64m','-XX:ActiveProcessorCount=1','--version')
    if ($version -notmatch '(?m)^(openjdk|java) 17\.') { throw 'Java 17 required' }
    $stage = New-PrivateStage $DestinationRoot
    $emptyConfig = Join-Path $stage 'openssl-empty.cnf'
    [IO.File]::WriteAllBytes($emptyConfig, [byte[]]@())
    # Snapshot public/encrypted inputs inside the private stage before validation/decryption.
    foreach ($pair in @(@($Envelope,'recovery.p7m',600000),@($Manifest,'manifest.json',16384),@($RecipientCertificate,'recipient.crt',16384))) {
        if ((Get-Item -LiteralPath $pair[0]).Length -gt $pair[2]) { throw 'Input too large' }
        [IO.File]::Copy($pair[0], (Join-Path $stage $pair[1]), $false)
    }
    $null = Invoke-Captured $NodeExe @('--max-old-space-size=64',$helper,'verify',(Join-Path $stage 'manifest.json'),(Join-Path $stage 'recovery.p7m'),(Join-Path $stage 'recipient.crt'),$ApprovedExporterSha256)
    $recipientBytes = Read-Password $RecipientPasswordDpapi
    $recipientPassword = [Text.UTF8Encoding]::new($false,$true).GetString($recipientBytes)
    if (-not $recipientPassword -or $recipientPassword -match '[\0\r\n]') { throw 'Invalid recipient password' }
    $payload = Join-Path $stage 'payload.pending.zip'
    # Invoke-Captured requires exit 0, including GCM authentication, before returning.
    $null = Invoke-Captured $OpenSslExe @('cms', '-decrypt','-binary','-inform','DER','-in',(Join-Path $stage 'recovery.p7m'),'-recip',(Join-Path $stage 'recipient.crt'),'-inkey',$RecipientPrivatePem,'-passin','env:IMPORT_RECIPIENT','-out',$payload) @{ IMPORT_RECIPIENT = $recipientPassword; OPENSSL_CONF = $emptyConfig; TEMP = $stage; TMP = $stage }
    [Array]::Clear($recipientBytes,0,$recipientBytes.Length); $recipientPassword = $null
    $null = Invoke-Captured $NodeExe @('--max-old-space-size=64',$helper,'unpack',$payload,$stage)
    $storeBytes = [IO.File]::ReadAllBytes((Join-Path $stage 'store-password.txt'))
    $keyBytes = [IO.File]::ReadAllBytes((Join-Path $stage 'key-password.txt'))
    $utf8 = [Text.UTF8Encoding]::new($false,$true)
    $storePassword = $utf8.GetString($storeBytes); $keyPassword = $utf8.GetString($keyBytes)
    $alias = $utf8.GetString([IO.File]::ReadAllBytes((Join-Path $stage 'alias.txt')))
    $proof = Prove-Key $stage $JdkBin $storePassword $keyPassword $alias 'd02d23b28cbc615e3686d181aedefbbe5de993a0b6ba3f8e4ea2b6160211b35f'
    Save-Password (Join-Path $stage 'store-password.dpapi') $storeBytes
    Save-Password (Join-Path $stage 'key-password.dpapi') $keyBytes
    $receipt = [ordered]@{ schema_version = 1; private_key_proof = 'jarsigner sign + verify; keytool signed JAR certificate'; signer_certificate_der_sha256 = $proof; recipient_certificate_der_sha256 = '5be66294eff75a2c9aee7ca70d71b94c740113a768f26f46b6c75346cc72e6a4'; exporter_sha256 = $ApprovedExporterSha256; ciphertext_sha256 = (Get-FileHash -LiteralPath (Join-Path $stage 'recovery.p7m') -Algorithm SHA256).Hash.ToLowerInvariant(); keystore_sha256 = (Get-FileHash -LiteralPath (Join-Path $stage 'key.p12') -Algorithm SHA256).Hash.ToLowerInvariant() }
    [IO.File]::WriteAllText((Join-Path $stage 'receipt.json'), ($receipt | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
    foreach ($name in @('payload.pending.zip','store-password.txt','key-password.txt','recovery.p7m','manifest.json','recipient.crt','openssl-empty.cnf')) { [IO.File]::Delete((Join-Path $stage $name)) }
    Assert-PrivateDirectory $DestinationRoot
    Publish-Bundle $stage $final
    $stage = $null
    $ok = $true
} catch {
    # No child output, values, exception details, command lines, or password hashes.
} finally {
    foreach ($bytes in @($recipientBytes,$storeBytes,$keyBytes)) { if ($null -ne $bytes) { [Array]::Clear($bytes,0,$bytes.Length) } }
    $recipientPassword = $null; $storePassword = $null; $keyPassword = $null; $alias = $null
    if ($stage) { try { Remove-OwnedStage $stage $DestinationRoot } catch { $ok = $false } }
}
if (-not $ok) { [Console]::Error.WriteLine('Local signing import failed.'); exit 1 }
