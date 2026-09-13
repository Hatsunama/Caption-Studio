param(
  [string]$GradleCache = (Join-Path $env:USERPROFILE '.gradle/caches/modules-2/files-2.1'),
  [string]$AndroidJar = (Join-Path $env:LOCALAPPDATA 'Android/Sdk/platforms/android-36/android.jar')
)
$ErrorActionPreference = 'Stop'
$translationRoot = Split-Path $PSScriptRoot -Parent
$translationScratch = Join-Path ([IO.Path]::GetTempPath()) ('caption-translation-tests-' + [Guid]::NewGuid().ToString('N'))
$translationClasses = Join-Path $translationScratch 'classes'
New-Item -ItemType Directory -Path $translationClasses -Force | Out-Null

function CachedJar([string]$Group, [string]$Artifact, [string]$Version = '*') {
  $matches = @(Get-ChildItem (Join-Path $GradleCache "$Group/$Artifact/$Version") -Recurse -Filter '*.jar' |
    Where-Object Name -NotMatch '-sources|-javadoc' | Sort-Object FullName)
  if (!$matches.Count) { throw "Missing cached dependency: $Group/$Artifact/$Version" }
  return $matches[-1].FullName
}

$gson = CachedJar 'com.google.code.gson' 'gson' '2.13.2'
$junit = CachedJar 'junit' 'junit' '4.13.2'
$hamcrest = CachedJar 'org.hamcrest' 'hamcrest-core' '1.3'
$stdlib = CachedJar 'org.jetbrains.kotlin' 'kotlin-stdlib' '2.3.0'
$annotations = CachedJar 'org.jetbrains' 'annotations'
$compiler = @(
  (CachedJar 'org.jetbrains.kotlin' 'kotlin-compiler-embeddable' '2.3.0'),
  $stdlib,
  (CachedJar 'org.jetbrains.kotlin' 'kotlin-script-runtime' '2.3.0'),
  (CachedJar 'org.jetbrains.kotlin' 'kotlin-reflect'),
  (CachedJar 'org.jetbrains.kotlin' 'kotlin-daemon-embeddable' '2.3.0'),
  (CachedJar 'org.jetbrains.kotlinx' 'kotlinx-coroutines-core-jvm'),
  $annotations
) -join [IO.Path]::PathSeparator
$aar = @(Get-ChildItem (Join-Path $GradleCache 'com.google.ai.edge.litertlm/litertlm-android/0.16.1') -Recurse -Filter '*.aar')[0].FullName
$litert = Join-Path $translationScratch 'litertlm.jar'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($aar)
try { [IO.Compression.ZipFileExtensions]::ExtractToFile($archive.GetEntry('classes.jar'), $litert) }
finally { $archive.Dispose() }

$nativeRoot = Join-Path $translationRoot 'modules/caption-translation/android/src'
$javaSources = @(Get-ChildItem (Join-Path $nativeRoot 'main/java/app/captionstudio/translation') -Filter '*.java' | ForEach-Object FullName)
$kotlinSource = Join-Path $nativeRoot 'main/java/app/captionstudio/translation/LiteRtLmTranslationRuntime.kt'
$classpath = @($translationClasses, $AndroidJar, $gson, $junit, $hamcrest, $stdlib, $annotations, $litert) -join [IO.Path]::PathSeparator
& java -cp $compiler org.jetbrains.kotlin.cli.jvm.K2JVMCompiler -no-stdlib -no-reflect -jvm-target 17 -classpath $classpath -d $translationClasses $kotlinSource @javaSources
if ($LASTEXITCODE -ne 0) { throw 'Kotlin translation runtime compilation failed' }
$testSources = @(Get-ChildItem (Join-Path $nativeRoot 'test/java/app/captionstudio/translation') -Filter '*.java' | ForEach-Object FullName)
& javac -encoding UTF-8 -cp $classpath -d $translationClasses @javaSources @testSources
if ($LASTEXITCODE -ne 0) { throw 'Java translation runtime/test compilation failed' }
$testClasses = @($testSources | ForEach-Object { 'app.captionstudio.translation.' + [IO.Path]::GetFileNameWithoutExtension($_) })
& java -cp $classpath org.junit.runner.JUnitCore @testClasses
if ($LASTEXITCODE -ne 0) { throw 'Native translation tests failed' }
Write-Output "Compiled real LiteRT adapter against cached 0.16.1 API; ran all native translation unit tests. Reports: $translationScratch"
