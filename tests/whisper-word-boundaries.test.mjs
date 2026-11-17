import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
const target = 'node_modules/whisper.rn/cpp/whisper.cpp';
const beforeSha = '4eeac03d31372e34193f670394de19e625c87878743ca90d39da398c20ace4a6';
const oldLine = '        if (acc + cur > max_len && i > 0 && should_split_on_word(txt, split_on_word)) {';
const newLine = '        if (acc + cur > max_len && i > 0 && should_split_on_word(txt, split_on_word) &&\n            token.t0 > segment.t0 && token.t0 < segment.t1) {';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const installed = fs.readFileSync(path.join(root, target), 'utf8');
// Recover only the one known hunk; verify the entire pristine file before use.
const pristine = installed.includes(newLine) ? installed.replace(newLine, oldLine) : installed;
assert.equal(sha(pristine), beforeSha);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'caption-whisper-boundary-'));
// Retained for review; these tests deliberately perform no deletes.
function fixture(version = '0.7.4', source = pristine) {
  const dir = fs.mkdtempSync(path.join(scratch, 'fixture-'));
  fs.mkdirSync(path.join(dir, path.dirname(target)), { recursive: true });
  fs.writeFileSync(path.join(dir, target), source);
  fs.writeFileSync(path.join(dir, 'node_modules/whisper.rn/package.json'), JSON.stringify({ version }));
  return dir;
}
const load = () => require('../scripts/patch-whisper-word-boundaries.js');

test('native split condition requires strict interior bounds (source check, not native execution)', () => {
  const source = process.env.WHISPER_BOUNDARY_INSTALLED === '1'
    ? installed
    : (() => { const dir = fixture(); load().patchWhisperWordBoundaries(dir); return fs.readFileSync(path.join(dir, target), 'utf8'); })();
  assert.ok(source.includes(newLine), 'actual whisper_wrap_segment lacks strict-interior guard; equal token.t0 creates zero intervals');
});

test('absent dependency tree is inert; incomplete and invalid trees fail closed', () => {
  const repair = load().patchWhisperWordBoundaries;
  const absent = fs.mkdtempSync(path.join(scratch, 'absent-'));
  assert.equal(repair(absent), false);
  assert.deepEqual(fs.readdirSync(absent), []);
  const incomplete = fs.mkdtempSync(path.join(scratch, 'incomplete-'));
  fs.mkdirSync(path.join(incomplete, 'node_modules'));
  assert.throws(() => repair(incomplete), /ENOENT/);
  assert.deepEqual(fs.readdirSync(path.join(incomplete, 'node_modules')), []);
  const invalid = fs.mkdtempSync(path.join(scratch, 'invalid-'));
  fs.writeFileSync(path.join(invalid, 'node_modules'), 'keep');
  assert.throws(() => repair(invalid), /Invalid node_modules/);
  assert.equal(fs.readFileSync(path.join(invalid, 'node_modules'), 'utf8'), 'keep');
});
test('installer is inert on import, whole-file pinned and byte-idempotent', () => {
  const { patchWhisperWordBoundaries, AFTER_SHA256 } = load();
  assert.equal(fs.readFileSync(path.join(root, target), 'utf8'), installed, 'import must not patch installed source');
  assert.equal(AFTER_SHA256, 'e6cd3b480140b6060af8fcd0da88e71babefb461399cdc0e91504149fff51b83');
  const dir = fixture(), file = path.join(dir, target);
  assert.equal(sha(fs.readFileSync(file)), beforeSha);
  assert.equal(patchWhisperWordBoundaries(dir), 'patched');
  const after = fs.readFileSync(file);
  assert.equal(sha(after), AFTER_SHA256);
  assert.equal(after.toString(), pristine.replace(oldLine, newLine));
  assert.equal(patchWhisperWordBoundaries(dir), 'already-patched');
  assert.deepEqual(fs.readFileSync(file), after);
});

test('unknown versions and any unknown whole-file bytes refuse before writes', () => {
  const { patchWhisperWordBoundaries } = load();
  for (const [version, source] of [['0.7.5', pristine], ['0.7.4', pristine + '\n'], ['0.7.4', pristine.replace(oldLine, '        if (true) {')]]) {
    const dir = fixture(version, source), file = path.join(dir, target);
    const names = fs.readdirSync(path.dirname(file));
    assert.throws(() => patchWhisperWordBoundaries(dir), /version|SHA-256/);
    assert.equal(fs.readFileSync(file, 'utf8'), source);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), names);
  }
  const patched = fixture(); patchWhisperWordBoundaries(patched);
  fs.writeFileSync(path.join(patched, 'node_modules/whisper.rn/package.json'), '{"version":"0.7.5"}');
  assert.throws(() => patchWhisperWordBoundaries(patched), /version/);
});

test('partial temporary write and rename failure leave original complete; corrupt postimage writes nothing', () => {
  const filename = path.join(root, 'scripts/patch-whisper-word-boundaries.js');
  const code = fs.readFileSync(filename, 'utf8');
  for (const failure of ['write', 'rename', 'hash']) {
    const brokenHash = failure === 'hash';
    const dir = fixture(), file = path.join(dir, target), module = { exports: {} };
    let writes = 0;
    const fakeFs = { ...fs, writeFileSync(...args) {
      writes++;
      if (failure === 'write') { fs.writeFileSync(args[0], 'partial', args[2]); throw Error('injected write failure'); }
      return fs.writeFileSync(...args);
    }, renameSync() { throw Error('injected rename failure'); } };
    vm.runInNewContext(brokenHash ? code.replace(load().AFTER_SHA256, '0'.repeat(64)) : code,
      { module, require: id => id === 'node:fs' ? fakeFs : require(id), process, console });
    assert.throws(() => module.exports.patchWhisperWordBoundaries(dir), brokenHash ? /postimage|SHA-256/ : /injected (write|rename) failure/);
    assert.equal(fs.readFileSync(file, 'utf8'), pristine);
    assert.equal(writes, brokenHash ? 0 : 1);
  }
});

test('a concurrent source or package change is refused before publication', () => {
  const filename = path.join(root, 'scripts/patch-whisper-word-boundaries.js');
  for (const change of ['source', 'version']) {
    const dir = fixture(), file = path.join(dir, target), module = { exports: {} };
    const foreign = pristine + '\nforeign edit\n';
    const fakeFs = { ...fs, writeFileSync(...args) {
      fs.writeFileSync(...args);
      fs.writeFileSync(change === 'source' ? file : path.join(dir, 'node_modules/whisper.rn/package.json'),
        change === 'source' ? foreign : '{"version":"0.7.5"}');
    } };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, require: id => id === 'node:fs' ? fakeFs : require(id), process, console });
    assert.throws(() => module.exports.patchWhisperWordBoundaries(dir), /changed before publication/);
    assert.equal(fs.readFileSync(file, 'utf8'), change === 'source' ? foreign : pristine);
  }
});

test('postinstall refuses whisper input before invoking any other repair', () => {
  const filename = path.join(root, 'scripts/patch-react-native-gradle.js');
  const module = { filename, exports: {} }, calls = [];
  const req = id => id === 'node:path' ? path : new Proxy({}, { get: (_, name) => () => {
    calls.push(name); if (name === 'patchWhisperWordBoundaries') throw Error('whisper refused');
  } });
  req.main = {};
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, require: req });
  assert.throws(() => module.exports.patchReactNativeGradle('fixture'), /whisper refused/);
  assert.deepEqual(calls, ['patchWhisperWordBoundaries']);
});

function extract(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, signature);
  const open = source.indexOf('{', start);
  let depth = 1, end = open + 1;
  while (depth && end < source.length) { if (source[end] === '{') depth++; if (source[end] === '}') depth--; end++; }
  assert.equal(depth, 0);
  return source.slice(start, end);
}

test('actual extracted C++ wrap algorithm: baseline RED and candidate GREEN', t => {
  // Caller on Windows must hold Local\\CaptionStudioNodeChecks for this entire process.
  const compiler = ['g++', 'clang++'].find(c => spawnSync(c, ['--version'], { encoding: 'utf8', timeout: 5000 }).status === 0);
  if (!compiler) {
    if (process.env.CI || process.platform !== 'win32') assert.fail('CI native acceptance requires existing g++ or clang++; no installation attempted');
    t.skip('Windows has no g++/clang++ on PATH; native RED/GREEN NOT EXECUTED'); return;
  }
  // Linux/macOS compiler is bounded by shell resource limits, no local Gradle/NDK.
  if (process.platform === 'win32') {
    if (process.env.CI) assert.fail('CI must provide POSIX resource limits for native harness');
    t.skip('Windows compiler resource limiter unavailable; native NOT EXECUTED'); return;
  }
  let candidate = installed;
  if (process.env.WHISPER_BOUNDARY_INSTALLED !== '1') {
    const dir = fixture(); load().patchWhisperWordBoundaries(dir);
    candidate = fs.readFileSync(path.join(dir, target), 'utf8');
  }
  const header = fs.readFileSync(path.join(root, 'node_modules/whisper.rn/cpp/whisper.h'), 'utf8');
  const token = extract(header, 'typedef struct whisper_token_data') + ' whisper_token_data;';
  const segment = extract(pristine, 'struct whisper_segment {') + ';';
  const helpers = extract(pristine, 'static inline bool should_split_on_word(') + '\n' + extract(pristine, 'static int utf8_len(');
  const signature = 'static int whisper_wrap_segment(';
  const native = extract(candidate, signature);
  const baseline = extract(pristine, signature).replace('whisper_wrap_segment(', 'baseline_wrap_segment(');
  const harness = fs.readFileSync(new URL('./fixtures/whisper-word-boundaries.cpp', import.meta.url), 'utf8');
  const file = path.join(scratch, 'harness.cpp'), binary = path.join(scratch, 'harness');
  fs.writeFileSync(file, '#include <cstdint>\n#include <string>\n#include <vector>\n#include <utility>\n#include <iostream>\n#include <cstdlib>\nusing whisper_token = int32_t;\n' + token + '\n' + segment + '\n' + harness.replace('// EXTRACTED_FUNCTIONS', helpers + '\n' + baseline + '\n' + native));
  assert.ok(os.freemem() >= 1024 ** 3, 'compile requires >=1 GiB free RAM');
  const compile = spawnSync('bash', ['-c', 'ulimit -v 393216 && ulimit -t 30 && exec "$@"', 'native-limit', compiler, '-std=c++17', '-O0', '-Wall', '-Wextra', file, '-o', binary], { encoding: 'utf8', timeout: 45000 });
  assert.equal(compile.status, 0, compile.stderr || String(compile.error));
  const red = spawnSync(binary, ['--baseline'], { encoding: 'utf8', timeout: 5000 });
  t.diagnostic(red.stdout + red.stderr);
  assert.equal(red.status, 1, 'pristine native algorithm must fail positive-interval regression');
  assert.match(red.stdout, /\[400,400\] \[400,400\]/);
  const green = spawnSync(binary, [], { encoding: 'utf8', timeout: 5000 });
  t.diagnostic(green.stdout + green.stderr);
  assert.equal(green.status, 0, green.stdout + green.stderr);
});
