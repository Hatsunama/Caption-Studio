$ErrorActionPreference = 'Stop'
$translationCache = Join-Path $env:USERPROFILE '.gradle/caches/modules-2/files-2.1'
$translationTestRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$translationScratch = Join-Path $translationTestRoot ('.focused-' + [Guid]::NewGuid().ToString('N'))
$translationClasses = Join-Path $translationScratch 'classes'
New-Item -ItemType Directory -Path $translationClasses -Force | Out-Null
function CachedJar([string]$Group, [string]$Artifact, [string]$Version = '*') {
  $matches = @(Get-ChildItem (Join-Path $translationCache "$Group/$Artifact/$Version") -Recurse -Filter '*.jar' |
    Where-Object Name -NotMatch '-sources|-javadoc' | Sort-Object FullName)
  if (!$matches.Count) { throw "Missing cached dependency: $Group/$Artifact/$Version" }
  return $matches[-1].FullName
}
try {
  $stdlib = CachedJar 'org.jetbrains.kotlin' 'kotlin-stdlib' '2.3.0'
  $annotations = CachedJar 'org.jetbrains' 'annotations'
  $compiler = @(
    (CachedJar 'org.jetbrains.kotlin' 'kotlin-compiler-embeddable' '2.3.0'), $stdlib,
    (CachedJar 'org.jetbrains.kotlin' 'kotlin-script-runtime' '2.3.0'),
    (CachedJar 'org.jetbrains.kotlin' 'kotlin-reflect'),
    (CachedJar 'org.jetbrains.kotlin' 'kotlin-daemon-embeddable' '2.3.0'),
    (CachedJar 'org.jetbrains.kotlinx' 'kotlinx-coroutines-core-jvm'), $annotations
  ) -join [IO.Path]::PathSeparator
  $aar = @(Get-ChildItem (Join-Path $translationCache 'com.google.ai.edge.litertlm/litertlm-android/0.16.1') -Recurse -Filter '*.aar')[0].FullName
  $litert = Join-Path $translationScratch 'litertlm.jar'
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [IO.Compression.ZipFile]::OpenRead($aar)
  try { [IO.Compression.ZipFileExtensions]::ExtractToFile($archive.GetEntry('classes.jar'), $litert) }
  finally { $archive.Dispose() }
  $nativeRoot = Split-Path $PSScriptRoot -Parent
  $javaSources = @(Get-ChildItem (Join-Path $nativeRoot 'main/java/app/captionstudio/translation') -Filter '*.java' | ForEach-Object FullName)
  $kotlinSource = Join-Path $nativeRoot 'main/java/app/captionstudio/translation/LiteRtLmTranslationRuntime.kt'
  $classpath = @($translationClasses,
    (Join-Path $env:LOCALAPPDATA 'Android/Sdk/platforms/android-36/android.jar'),
    (CachedJar 'com.google.code.gson' 'gson' '2.13.2'),
    (CachedJar 'junit' 'junit' '4.13.2'), (CachedJar 'org.hamcrest' 'hamcrest-core' '1.3'),
    $stdlib, $annotations, $litert) -join [IO.Path]::PathSeparator
  & java -Xmx384m -XX:ActiveProcessorCount=2 "-Djava.io.tmpdir=$translationScratch" -cp $compiler org.jetbrains.kotlin.cli.jvm.K2JVMCompiler -no-stdlib -no-reflect -jvm-target 17 -classpath $classpath -d $translationClasses $kotlinSource @javaSources
  if ($LASTEXITCODE -ne 0) { throw 'Kotlin translation compilation failed' }
  $testSources = @(Get-ChildItem (Join-Path $PSScriptRoot 'java/app/captionstudio/translation') -Filter '*.java' | ForEach-Object FullName)
  & javac -J-Xmx256m -J-XX:ActiveProcessorCount=2 -encoding UTF-8 -cp $classpath -d $translationClasses @javaSources @testSources
  if ($LASTEXITCODE -ne 0) { throw 'Java translation compilation failed' }
  $testClasses = @($testSources | ForEach-Object { 'app.captionstudio.translation.' + [IO.Path]::GetFileNameWithoutExtension($_) })
  & java -Xmx192m -XX:ActiveProcessorCount=2 "-Djava.io.tmpdir=$translationScratch" -cp $classpath org.junit.runner.JUnitCore @testClasses
  if ($LASTEXITCODE -ne 0) { throw 'Native translation tests failed' }
  Write-Output 'Compiled real LiteRT-LM 0.16.1 adapter; focused native tests passed.'
} finally {
  $resolvedScratch = [IO.Path]::GetFullPath($translationScratch)
  if (!$resolvedScratch.StartsWith($translationTestRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Refusing cleanup outside native test directory'
  }
  Remove-Item -LiteralPath $resolvedScratch -Recurse -Force
}
