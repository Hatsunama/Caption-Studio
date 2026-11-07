import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { privateFramePtsTarget as map } from '../src/components/editor/private-frame-pts-diagnostic.ts';
import { patchPrivateFramePts as patch } from '../scripts/private-frame-pts-diagnostic.mjs';
import * as diagnostic from '../scripts/private-frame-pts-diagnostic.mjs';

const root = new URL('../', import.meta.url);
const nativeBase = 'android/src/main/java/expo/modules/video/';
const files = ['package.json', nativeBase + 'player/VideoPlayer.kt', nativeBase + 'VideoModule.kt'];
const fixture = { displayName: 'cs-166-samsung.mp4', durationMs: 8000, width: 360, height: 640 };

function manifestFixture(t, value) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'cs-private-source-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'package.json');
  fs.writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
  return path;
}

test('packaging configuration regression: private SDK source patch must opt expo-video out of prebuilt AAR', t => {
  const path = manifestFixture(t, { name: 'fixture', dependencies: { 'expo-video': '~57.0.5' } });
  assert.equal(typeof diagnostic.configurePrivateFramePts, 'function', 'old native-only patch never configured source compilation');
  assert.equal(diagnostic.configurePrivateFramePts(path), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path, 'utf8')).expo.autolinking.android.buildFromSource, ['expo-video']);
});

test('source configuration preserves existing settings and is byte-idempotent', t => {
  const before = { name: 'fixture', expo: { other: true, autolinking: {
    buildFromSource: ['inherited-module'], ios: { exclude: ['ios-module'] },
    android: { exclude: ['android-module'], buildFromSource: ['existing-module'] },
  } } };
  const path = manifestFixture(t, before);
  assert.equal(diagnostic.configurePrivateFramePts(path), true);
  const after = fs.readFileSync(path, 'utf8');
  before.expo.autolinking.android.buildFromSource.push('expo-video');
  assert.deepEqual(JSON.parse(after), before);
  assert.equal(diagnostic.configurePrivateFramePts(path), false);
  assert.equal(fs.readFileSync(path, 'utf8'), after);
  const inherited = manifestFixture(t, { expo: { autolinking: { buildFromSource: ['inherited-module'] } } });
  diagnostic.configurePrivateFramePts(inherited);
  assert.deepEqual(JSON.parse(fs.readFileSync(inherited, 'utf8')).expo.autolinking.android.buildFromSource,
    ['inherited-module', 'expo-video']);
});

test('invalid source config fails without overriding or writing any bytes', t => {
  for (const value of [null, [], { expo: null }, { expo: [] }, { expo: 'bad' },
    { expo: { autolinking: false } }, { expo: { autolinking: { android: [] } } },
    { expo: { autolinking: { buildFromSource: 'bad' } } },
    ...[null, 'expo-video', [42], {}].map(buildFromSource => ({ expo: { autolinking: { android: { buildFromSource } } } }))]) {
    const path = manifestFixture(t, value), before = fs.readFileSync(path, 'utf8');
    assert.throws(() => diagnostic.configurePrivateFramePts(path), /config/);
    assert.equal(fs.readFileSync(path, 'utf8'), before);
  }
});

test('single manifest staging/rename failures leave original bytes and no temporary files', t => {
  for (const operation of ['writeFileSync', 'renameSync']) {
    const path = manifestFixture(t, { name: 'fixture' }), before = fs.readFileSync(path, 'utf8');
    const io = { ...fs, [operation]() { throw new Error('injected config IO failure'); } };
    assert.throws(() => diagnostic.configurePrivateFramePts(path, io), /injected config IO failure/);
    assert.equal(fs.readFileSync(path, 'utf8'), before);
    assert.deepEqual(fs.readdirSync(join(path, '..')), ['package.json']);
  }
});

test('known sample mapping is limited to two exact paused Android fixtures and original target window', () => {
  for (const displayName of [fixture.displayName, 'cs-166-seeker.mp4']) {
    for (const target of [6.380, 6.385416, 6.390]) assert.equal(map(target, { ...fixture, displayName }, 8, 'android', false), 6.375);
  }
  for (const delta of [{ displayName: 'CS-166-samsung.mp4' }, { displayName: 'other.mp4' },
    { durationMs: '8000' }, { durationMs: 7999 }, { width: '360' }, { width: 640 },
    { height: '640' }, { height: 360 }]) assert.equal(map(6.385416, { ...fixture, ...delta }, 8, 'android', false), 6.385416);
  for (const duration of ['8', 7.999, NaN, undefined]) assert.equal(map(6.385416, fixture, duration, 'android', false), 6.385416);
  for (const platform of ['ios', 'web', 'windows']) assert.equal(map(6.385416, fixture, 8, platform, false), 6.385416);
  assert.equal(map(6.385416, fixture, 8, 'android', true), 6.385416);
  for (const target of [0, 6.375, 6.379999, 6.390001, 8, Infinity, NaN]) assert.ok(Object.is(map(target, fixture, 8, 'android', false), target));
});

function copyInstalled(t) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'cs-private-pts-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const file of files) {
    let content = fs.readFileSync(new URL('node_modules/expo-video/' + file, root), 'utf8').replace(/\r\n/g, '\n');
    // CI runs these checks after the explicit patch step. Reconstruct pristine
    // text only IN THE TEMP COPY, then test initial application as well as reruns.
    content = content.replace(/  \/\/ PRIVATE DISPOSABLE: about-to-render PTS[\s\S]*?(?=  internal val firstFrameEventGenerator:)/, '')
      .replace(/            try \{\n              ref\.privateFramePtsDiagnostic\(currentTime\)\n            \} catch \(_: Throwable\) \{\n              \/\/ Observational diagnostics must never fail the seek\.\n            \}\n/, '');
    fs.mkdirSync(join(dir, file, '..'), { recursive: true });
    fs.writeFileSync(join(dir, file), content);
  }
  return dir;
}
const snapshot = dir => files.map(file => fs.readFileSync(join(dir, file), 'utf8'));

test('generated native source (not native proof): matching seeks report entry and install without ready metadata', t => {
  const dir = copyInstalled(t);
  patch(dir);
  const player = snapshot(dir)[1];
  const addition = player.slice(player.indexOf('  // PRIVATE DISPOSABLE:'), player.indexOf('  internal val firstFrameEventGenerator:'));
  const seek = addition.slice(addition.indexOf('internal fun privateFramePtsDiagnostic'));
  assert.match(seek, /privateFramePtsLog\("stage=1 requestedMs="/,
    'old probe can return silently before providing any native entry evidence');
  assert.doesNotMatch(seek, /if \([^\n]*(?:duration|format\?|format\.height)/,
    'duration/format readiness must not prevent matching-seek listener installation');
  assert.ok(seek.indexOf('stage=1 requestedMs=') < seek.indexOf('setVideoFrameMetadataListener('));
  assert.match(seek, /durationMs=.*durationMs[\s\S]*width=.*format\?\.width[\s\S]*height=.*format\?\.height/);
  assert.match(seek, /stage=2/); // installation succeeded
  assert.match(seek, /stage=3/); // listener already installed
  assert.match(seek, /stage=4/); // metadata snapshot failed
  assert.match(seek, /stage=5/); // listener installation failed
});

test('generated source (not native proof) preserves originals, idempotence and bounded observational callbacks', t => {
  const dir = copyInstalled(t), before = snapshot(dir);
  assert.equal(patch(dir), true);
  const after = snapshot(dir);
  assert.equal(patch(dir), false); assert.deepEqual(snapshot(dir), after);
  const player = after[1], module = after[2];
  assert.match(module, /\.set \{ ref: VideoPlayer, currentTime: Double ->\n          appContext.mainQueue.launch \{\n            try \{\n              ref.privateFramePtsDiagnostic\(currentTime\)[\s\S]*?catch \(_: Throwable\)[\s\S]*?ref.player.seekTo\(\(currentTime \* 1000\).toLong\(\)\)/);
  assert.equal(module.match(/ref\.privateFramePtsDiagnostic\(/g).length, 1);
  assert.equal(player.match(/setVideoFrameMetadataListener\(/g).length, 1);
  const addition = player.slice(player.indexOf('  // PRIVATE DISPOSABLE:'), player.indexOf('  internal val firstFrameEventGenerator:'));
  assert.match(addition, /AtomicInteger\(0\)/);
  assert.match(addition, /@Volatile private var privateFramePtsRequest: PrivateFramePtsRequest\? = null/);
  assert.match(addition, /private data class PrivateFramePtsRequest\(val requestedMs: Double, val isPlayingAtSeek: Int\)/);
  assert.match(addition, /private val privateFramePtsPlayerId = System.identityHashCode\(player\)/);
  assert.match(addition, /privateFramePtsRequest = null\n    if \(!\(seconds == 6\.375 \|\| seconds in 6\.380\.\.6\.390\)\) return\n    if \(privateFramePtsCount.get\(\) >= 64\) return/);
  assert.match(addition, /val isPlayingAtSeek = if \(player.isPlaying\) 1 else 0/);
  const callbackStart = addition.indexOf('VideoFrameMetadataListener {');
  const callback = addition.slice(callbackStart, addition.indexOf('\n      )', callbackStart));
  assert.doesNotMatch(callback, /player\.|uri|source|displayName|\.play\(|\.seekTo\(/i);
  assert.doesNotMatch(callback, /privateFramePtsRequest\s*=|privateFramePtsInstalled\s*=|frameFormat\.(?:width|height)\s*==/);
  assert.match(callback, /val request = privateFramePtsRequest\n            if \(request != null && privateFramePtsCount.get\(\) < 64\)/);
  assert.match(callback, /stage=7 requestedMs=.*request.requestedMs[\s\S]*actualPresentationTimeUs=.*presentationTimeUs[\s\S]*width=.*frameFormat.width[\s\S]*height=.*frameFormat.height[\s\S]*isPlayingAtSeek=.*request.isPlayingAtSeek[\s\S]*playerId=.*privateFramePtsPlayerId/);
  assert.match(callback, /catch \(_: Throwable\)/);
  assert.match(callback, /stage=6 playerId=/);
  assert.match(addition, /getAndUpdate \{ if \(it < 64\) it \+ 1 else it \}/);
  assert.match(addition, /if \(count < 64\) \{\n      try \{\n        android.util.Log.w\("CS_FRAME_PTS", message\)/);
  assert.equal(addition.match(/Log\./g).length, 1);
  assert.doesNotMatch(addition, /(?:Count|count)\.set\(|cs-166|file:\/\/|content:\/\/|\.message|\.toString\(|\.play\(|\.seekTo\(/);
  assert.match(addition, /privateFramePtsInstalled = true\n      privateFramePtsLog\("stage=2/);
  assert.match(addition, /catch \(_: Throwable\) \{\n      privateFramePtsRequest = null[\s\S]*stage=5/);
  assert.equal(player.replace(addition, ''), before[1], 'all existing player code survives byte-for-byte');
  assert.equal(module.replace(/            try \{[\s\S]*?ref.privateFramePtsDiagnostic\(currentTime\)[\s\S]*?            \}\n/, ''), before[2]);
});

test('wrong versions, either missing/duplicate anchor, unknown edits and partial patches fail before any write', t => {
  for (const kind of ['version', 'player-anchor', 'setter-anchor', 'duplicate', 'unknown-edit', 'partial', 'tampered-patch']) {
    const dir = copyInstalled(t);
    const file = join(dir, kind === 'version' ? files[0] : kind === 'player-anchor' ? files[1] : files[2]);
    if (kind === 'partial' || kind === 'tampered-patch') {
      patch(dir);
      if (kind === 'partial') {
        const pristine = copyInstalled(t); fs.copyFileSync(join(pristine, files[2]), file);
      } else fs.appendFileSync(file, '\n// unexpected edit');
    } else {
      let text = fs.readFileSync(file, 'utf8');
      text = kind === 'version' ? text.replace('57.0.5', '57.0.6')
        : kind === 'player-anchor' ? text.replace('internal val firstFrameEventGenerator', 'internal val changed')
        : kind === 'setter-anchor' ? text.replace('currentTime: Double ->', 'changed: Double ->')
        : kind === 'duplicate' ? text + text : text + '\n// unexpected edit';
      fs.writeFileSync(file, text);
    }
    const before = snapshot(dir);
    assert.throws(() => patch(dir), /requires|mismatch|partial/);
    assert.deepEqual(snapshot(dir), before, kind);
  }
});

test('staging and second-file commit failures restore both original sources', t => {
  for (const operation of ['writeFileSync', 'renameSync']) {
    const dir = copyInstalled(t), before = snapshot(dir);
    let calls = 0;
    const io = { ...fs, [operation](...args) {
      if (++calls === 2) throw new Error('injected IO failure');
      return fs[operation](...args);
    } };
    assert.throws(() => patch(dir, io), /injected IO failure/);
    assert.deepEqual(snapshot(dir), before);
    for (const file of files.slice(1)) assert.deepEqual(fs.readdirSync(join(dir, file, '..')).filter(name => name.endsWith('.tmp')), []);
  }
});

test('CLI refuses local/main/push execution and workflow gates only the exact private dispatch', () => {
  for (const args of [[], ['--configure-source']]) {
    for (const env of [{ GITHUB_ACTIONS: 'false' }, { GITHUB_REF: 'refs/heads/main' }, { GITHUB_EVENT_NAME: 'push' }]) {
      const result = spawnSync(process.execPath, ['--max-old-space-size=128', 'scripts/private-frame-pts-diagnostic.mjs', ...args], {
        cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'true',
          GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/diagnostic/paused-frame-pts-20261107', ...env },
      });
      assert.equal(result.status, 1); assert.match(result.stderr, /requires the private branch CI dispatch/);
    }
  }
  const workflow = fs.readFileSync(new URL('.github/workflows/ci.yml', root), 'utf8');
  const gate = "        if: github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/diagnostic/paused-frame-pts-20261107'";
  const setup = [
    '      - name: Apply disposable private frame PTS diagnostic', gate, '        run: |',
    '          node --max-old-space-size=256 scripts/private-frame-pts-diagnostic.mjs --configure-source',
    '          node --max-old-space-size=256 scripts/private-frame-pts-diagnostic.mjs',
    '          python3 -B tests/private-frame-pts-apk.test.py',
  ].join('\n');
  assert.ok(workflow.includes('run: npm ci\n' + setup + '\n      - name: Audit production dependencies'));
  assert.ok(workflow.indexOf(setup) < workflow.indexOf('npx expo prebuild'));
  const verify = [
    '      - name: Verify private PTS DEX marker packaging (not render proof)', gate,
    '        run: python3 -B scripts/verify-private-frame-pts-apk.py android/app/build/outputs/apk/release/app-release.apk',
  ].join('\n');
  assert.ok(workflow.includes(verify));
  assert.ok(workflow.indexOf(verify) > workflow.indexOf('./gradlew :app:assembleRelease'));
  assert.ok(workflow.indexOf(verify) < workflow.indexOf('      - name: Retain native unit-test reports'));
  assert.ok(workflow.indexOf(verify) < workflow.indexOf('      - name: Retain CI-signed release-validation APK and AAB'));
});
