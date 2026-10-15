import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Execute the real runner and its functions. Replace only its ADB transport via
// the PowerShell AST; no adb executable is resolved or launched by these tests.
const runner = fileURLToPath(new URL('./verify-timeline-native-gesture.ps1', import.meta.url));
const harness = String.raw`
param([string]$Runner, [string]$Root)
$ErrorActionPreference = 'Stop'
$source = [IO.File]::ReadAllText($Runner)
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
$transport = $ast.Find({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Invoke-Adb' }, $true)
if (-not $transport) { throw 'ADB transport not found' }
$stub = @'
function Invoke-Adb {
    param([string[]]$AdbArguments)
    $op = $AdbArguments -join ' '
    $script:trace.Add($op)
    if ($op -eq 'get-state') {
        if ($script:scenario -eq 'unauthorized') { return 'unauthorized' }
        return 'device'
    }
    if ($op -eq 'shell dumpsys activity activities') {
        $script:guards++
        $foreign = $script:scenario -eq 'wrong-app' -or $script:switched
        if ($script:scenario -eq 'before-input' -and (Test-Path -LiteralPath (Join-Path $runDirectory 'result.json'))) { $foreign = $true }
        if ($foreign) { return 'mResumedActivity: ActivityRecord{123 u0 com.foreign.app/.Main t1}' }
        if ($script:scenario -eq 'spoofed-package') { return 'mResumedActivity: ActivityRecord{123 u0 com.xmilo_at_your_side.caption_studio.evil/.Main t1}' }
        return 'mResumedActivity: ActivityRecord{123 u0 com.xmilo_at_your_side.caption_studio/.Main t1}'
    }
    if ($op -like 'shell uiautomator dump *') {
        if ($script:scenario -eq 'bad-dump') { return 'ERROR: failed (stale XML exists)' }
        if ($script:scenario -eq 'race-dump') { $script:switched = $true }
        return ('UI hierchary dumped to: ' + $AdbArguments[3])
    }
    if ($op -like 'shell screencap *') {
        if ($script:scenario -eq 'race-screen') { $script:switched = $true }
        return ''
    }
    if ($AdbArguments[0] -eq 'pull') {
        if ($AdbArguments[1].EndsWith('.xml')) {
            $end = if ($script:swipes -eq 0) { '5.5' } else { '4.5' }
            $description = 'Hello.+. Selected. Start 1.25 seconds, end ' + $end + ' seconds. end'
            if ($script:scenario -eq 'video') { $description = 'End trim handle' }
            if ($script:scenario -eq 'wrong-prefix') { $description = 'HelloZZ. Selected. Start 1.25 seconds, end ' + $end + ' seconds. end' }
            $bounds = if ($script:scenario -eq 'clipped') { '[-1,100][200,150]' } else { '[100,100][200,150]' }
            $xml = '<hierarchy rotation="0"><node package="com.xmilo_at_your_side.caption_studio" bounds="[0,0][1080,1920]"><node content-desc="' + $description + '" bounds="' + $bounds + '"/><node text="0:02 / 0:10" bounds="[10,10][200,50]"/></node></hierarchy>'
            if ($script:scenario -eq 'foreign-xml') { $xml = $xml.Replace('com.xmilo_at_your_side.caption_studio', 'com.foreign.app') }
            if ($script:scenario -eq 'dtd') { $xml = '<!DOCTYPE hierarchy [<!ENTITY x "unsafe">]>' + $xml }
            [IO.File]::WriteAllText($AdbArguments[2], $xml)
            if ($script:scenario -eq 'race-xml-pull') { $script:switched = $true }
        } else {
            [IO.File]::WriteAllBytes($AdbArguments[2], [byte[]]@(137,80,78,71,13,10,26,10))
            if ($script:scenario -eq 'race-png-pull') { $script:switched = $true }
        }
        return ''
    }
    if ($op -eq 'shell wm size') { return 'Physical size: 1080x1920' }
    if ($op -like 'shell input swipe *') { $script:swipes++; return '' }
    if ($op -like 'shell rm -f *') { return '' }
    throw "Unexpected stub ADB operation: $op"
}
'@
$source = $source.Substring(0, $transport.Extent.StartOffset) + $stub + $source.Substring($transport.Extent.EndOffset)
function Get-Command { param($Name, $CommandType, $ErrorAction) if ($Name -ne 'adb') { throw 'Unexpected command lookup' }; return @{Source = 'NEVER-LAUNCH-ADB'} }
$results = @()
foreach ($case in @('wrong-app','unauthorized','spoofed-package','race-dump','race-screen','race-xml-pull','race-png-pull','foreign-xml','before-input','valid','video','bad-dump','wrong-prefix','clipped','dtd','cleanup')) {
    $script:scenario = $case; $script:switched = $false; $script:guards = 0; $script:swipes = 0
    $script:trace = New-Object 'Collections.Generic.List[string]'
    $evidence = Join-Path $Root $case
    $null = New-Item -ItemType Directory -Path $evidence
    $caught = ''; $output = @(); $cleanup = $null
    try {
        if ($case -eq 'cleanup') {
            # Run the actual cleanup function independently with adversarial paths.
            $patchedAst = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$parseErrors)
            $fn = $patchedAst.Find({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Remove-OwnedCapture' }, $true)
            if (-not $fn) { throw 'Missing owned capture cleanup function' }
            . ([scriptblock]::Create($fn.Extent.Text))
            $runId = 'a' * 32
            $EvidenceDirectory = $evidence
            $runDirectory = Join-Path $evidence ('timeline-native-' + $runId)
            $null = New-Item -ItemType Directory -Path $runDirectory
            $ownedCapturePaths = New-Object 'Collections.Generic.List[string]'
            $own = Join-Path $runDirectory ('before-' + ('b' * 32) + '.xml')
            $outside = Join-Path $evidence 'outside.xml'
            $sibling = Join-Path $runDirectory 'result.json'
            foreach ($p in @($own, $outside, $sibling)) { [IO.File]::WriteAllText($p, 'keep') }
            $ownedCapturePaths.Add($own)
            $rejected = 0
            foreach ($p in @($outside, $sibling, (Join-Path (Join-Path $runDirectory '..') 'outside.xml'))) {
                try { Remove-OwnedCapture $p } catch { $rejected++ }
            }
            Remove-OwnedCapture $own
            $cleanup = @{Rejected=$rejected; OwnExists=(Test-Path -LiteralPath $own); OutsideExists=(Test-Path -LiteralPath $outside); SiblingExists=(Test-Path -LiteralPath $sibling)}
        } else {
            $output = @(& ([scriptblock]::Create($source)) -Serial 'STUB-ONLY' -ArtifactLabelPrefix 'Hello.+' -EvidenceDirectory $evidence -AllowEdits)
        }
    } catch { $caught = $_.Exception.Message }
    $files = @(Get-ChildItem -LiteralPath $evidence -Recurse -File)
    $report = $null
    $reportFile = $files | Where-Object Name -eq 'result.json' | Select-Object -First 1
    if ($reportFile -and $case -ne 'cleanup') { $report = Get-Content -LiteralPath $reportFile.FullName -Raw | ConvertFrom-Json }
    $results += @{Case=$case; Error=$caught; Trace=@($script:trace.ToArray()); Swipes=$script:swipes; Guards=$script:guards; Captures=@($files | Where-Object Extension -in @('.xml','.png') | ForEach-Object Name); Report=$report; Output=($output -join " "); Cleanup=$cleanup}
}
$results | ConvertTo-Json -Depth 12 -Compress
`;
const candidates = process.platform === 'win32' ? ['powershell.exe', 'pwsh'] : ['pwsh', 'powershell.exe'];
let powershell;
for (const candidate of candidates) {
  const probe = spawnSync(candidate, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8', timeout: 10000 });
  if (probe.error?.code === 'ENOENT') continue;
  if (probe.error) throw probe.error;
  assert.equal(probe.status, 0, probe.stderr);
  powershell = candidate;
  break;
}
assert.ok(powershell, 'PowerShell is required: install/provide pwsh on Ubuntu or powershell.exe/pwsh on Windows; no CI skip');

function runHarness(execute = spawnSync) {
  const temporary = mkdtempSync(join(tmpdir(), 'timeline-safety-'));
  let primary;
  try {
    const path = join(temporary, 'harness.ps1');
    writeFileSync(path, harness);
    const result = execute(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path, runner, temporary], { encoding: 'utf8', timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || `PowerShell terminated: ${result.signal}`);
    return new Map(JSON.parse(result.stdout.trim()).map(entry => [entry.Case, entry]));
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    try {
      const child = relative(resolve(tmpdir()), resolve(temporary));
      assert.ok(child && !isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`));
      assert.equal(lstatSync(temporary).isSymbolicLink(), false);
      rmSync(temporary, { recursive: true, force: true });
    } catch (cleanupError) {
      if (!primary) throw cleanupError;
      primary.message += `; harness cleanup failed: ${cleanupError.message}`;
    }
  }
}
const cases = runHarness();

for (const code of ['ENOENT', 'ETIMEDOUT']) {
  test(`harness ${code}: preserves failure and removes its temporary files`, () => {
    let allocated;
    const failure = Object.assign(new Error(`simulated ${code}`), { code });
    assert.throws(() => runHarness((_command, args) => {
      allocated = args.at(-1);
      assert.ok(existsSync(join(allocated, 'harness.ps1')));
      writeFileSync(join(allocated, 'partial.xml'), 'partial capture');
      return { error: failure, status: null, signal: code === 'ETIMEDOUT' ? 'SIGTERM' : null };
    }), error => error === failure);
    assert.equal(existsSync(allocated), false);
  });
}

for (const name of ['wrong-app', 'unauthorized', 'spoofed-package']) {
  test(`${name}: aborts before capture or input`, () => {
    const r = cases.get(name);
    assert.ok(r.Error, 'must reject unsafe device/app');
    assert.equal(r.Trace.some(op => /uiautomator|screencap|^pull |input/.test(op)), false, r.Trace.join('\n'));
  });
}
for (const name of ['race-dump', 'race-screen', 'race-xml-pull', 'race-png-pull', 'foreign-xml']) {
  test(`${name}: discards all run captures and never swipes`, () => {
    const r = cases.get(name);
    assert.ok(r.Error, 'must reject foreground race');
    assert.match(r.Error, /foreground|package/i, 'reject for the intended safety reason');
    assert.equal(r.Swipes, 0);
    assert.deepEqual(r.Captures, []);
  });
}
test('foreground checked immediately before input', () => {
  const r = cases.get('before-input');
  assert.ok(r.Error);
  assert.equal(r.Swipes, 0);
  assert.deepEqual(r.Captures, []);
});
test('whole-second text cannot produce precise no-seek PASS', () => {
  const r = cases.get('valid');
  assert.equal(r.Error, '');
  assert.equal(r.Swipes, 1);
  assert.equal(r.Report.Passed, false);
  assert.equal(r.Report.TimingResizeVerified, true);
  assert.equal(r.Report.PrecisePlayheadVerified, false);
  assert.match(r.Output, /UNVERIFIED/);
  assert.equal(r.Captures.length, 4);
  assert.equal(r.Report.SwipeAttempted, true);
  for (let i = 0; i < r.Trace.length; i++) {
    if (/uiautomator|screencap|^pull |^shell wm size|^shell input/.test(r.Trace[i])) {
      assert.equal(r.Trace[i - 1], 'shell dumpsys activity activities', 'foreground guard immediately precedes operation');
      assert.equal(r.Trace[i + 1], 'get-state', 'device rechecked immediately after operation');
      assert.equal(r.Trace[i + 2], 'shell dumpsys activity activities', 'foreground rechecked immediately after operation');
    }
  }
  assert.equal(new Set(r.Captures).size, 4, 'fresh local paths per capture');
  const dumps = r.Trace.filter(op => op.startsWith('shell uiautomator dump '));
  assert.equal(new Set(dumps).size, 2, 'fresh remote paths per capture');
  assert.ok(r.Trace.some(op => op.startsWith('pull ') && op.includes('.png')), 'binary capture uses pull');
});
test('video is explicitly unsupported in TimedBlock mode', () => {
  const r = cases.get('video');
  assert.equal(r.Swipes, 0);
  assert.match(r.Error, /TimedBlock.*video|video.*TimedBlock/i);
});
for (const name of ['bad-dump', 'wrong-prefix', 'clipped', 'dtd']) {
  test(`${name}: existing rejection remains effective`, () => {
    const r = cases.get(name);
    assert.ok(r.Error);
    assert.equal(r.Swipes, 0);
    if (name === 'bad-dump') assert.equal(r.Trace.some(op => op.startsWith('pull ')), false);
  });
}
test('cleanup removes only exact owned capture paths in the unique run directory', () => {
  const r = cases.get('cleanup');
  assert.equal(r.Error, '');
  assert.deepEqual(r.Cleanup, { Rejected: 3, OwnExists: false, OutsideExists: true, SiblingExists: true });
});
