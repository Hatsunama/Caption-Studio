import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { parseSelectedVersions, verifyNativeNoticeVersions } = require('../scripts/verify-native-notice-versions.cjs');
const canonical = require('../shared/native-notice-versions.json');
const reflect = 'org.jetbrains.kotlin:kotlin-reflect';
const coroutines = 'org.jetbrains.kotlinx:kotlinx-coroutines-android';
const fixture = readFileSync(new URL('./fixtures/native-notice-runtime.txt', import.meta.url), 'utf8');
const graph = (r = '2.3.21', c = '1.10.2') => `+--- ${reflect}:${r}\n\\--- ${coroutines}:${c}\n`;

test('frozen verified artifact selections match canonical metadata', () => {
  assert.deepEqual(verifyNativeNoticeVersions(fixture), canonical);
});

test('caller parentheses never override selected components', () => {
  assert.deepEqual(parseSelectedVersions(fixture), canonical);
  assert.throws(() => parseSelectedVersions(`+--- caller:module:1.0 (requested ${reflect}:2.3.21)\n+--- caller:module:1.0 (requested ${coroutines}:1.10.2)`), /Missing selected/);
});

test('explicit selection arrows take precedence over requested versions', () => {
  assert.deepEqual(verifyNativeNoticeVersions(graph('2.2.21 -> 2.3.21', '1.9.0 -> 1.10.2')), canonical);
  assert.deepEqual(verifyNativeNoticeVersions(graph('2.+ -> 2.3.21', '[1,2) -> 1.10.2')), canonical);
});

test('repeated identical selections including nested tree lines are unambiguous', () => {
  assert.deepEqual(verifyNativeNoticeVersions(graph() + `|    \\--- ${reflect}:2.3.21 (*)\n     +--- ${coroutines}:1.10.2 (requested other:module:0.1) (*)`), canonical);
});

test('conflicting selected versions fail even if one matches the notice', () => {
  for (const id of [reflect, coroutines]) {
    assert.throws(() => verifyNativeNoticeVersions(graph() + `|    +--- ${id}:9.9.9\n`), /Ambiguous selected versions/);
  }
});

test('either missing component and empty reports fail closed', () => {
  for (const report of ['', `+--- ${reflect}:2.3.21`, `+--- ${coroutines}:1.10.2`]) {
    assert.throws(() => verifyNativeNoticeVersions(report), /Missing selected component/);
  }
});

test('unknown, dynamic, malformed and unresolved actual versions fail', () => {
  for (const value of ['unspecified', '+', '2.+', '[2,3)', '2.3.21-SNAPSHOT', '2.3.21 FAILED', '2.3.21 (n)', '2.2.21 -> unknown', '2.3.21 ->', '2.3.21 -> 2.3.21 -> 2.3.21']) {
    assert.throws(() => verifyNativeNoticeVersions(graph(value)), /Unknown actual version/, value);
  }
});

test('unknown actual selection is not hidden by a valid duplicate', () => {
  assert.throws(() => verifyNativeNoticeVersions(graph() + `+--- ${reflect}:unknown`), /Unknown actual version/);
});

test('only ASCII tree prefixes and exact component identities count', () => {
  const decoys = [`log ${reflect}:2.3.21`, `│ +--- ${reflect}:2.3.21`, `+--- ${reflect}-extra:2.3.21`, `+--- caller:module:1.0 (${reflect}:2.3.21)`];
  for (const line of decoys) assert.throws(() => parseSelectedVersions(line + `\n+--- ${coroutines}:1.10.2`), /Missing selected/);
});

test('LF, CRLF, CR and UTF-8 BOM receipts have identical selections', () => {
  for (const ending of ['\n', '\r\n', '\r']) {
    assert.deepEqual(verifyNativeNoticeVersions('\uFEFF' + fixture.replace(/\r\n|\n|\r/g, ending)), canonical);
  }
});

test('metadata mismatches for either component fail', () => {
  for (const id of [reflect, coroutines]) {
    assert.throws(() => verifyNativeNoticeVersions(fixture, { ...canonical, [id]: '0.0.1' }), /version mismatch/);
  }
});

test('missing, extra and invalid metadata fail', () => {
  for (const metadata of [null, [], {}, { [reflect]: '2.3.21' }, { ...canonical, extra: '1.0.0' }, { ...canonical, [reflect]: 'unknown' }, { ...canonical, [reflect]: 2.3 }]) {
    assert.throws(() => verifyNativeNoticeVersions(fixture, metadata), /Invalid native notice version metadata/);
  }
});


test('constraints alone cannot establish a selected packaged component', () => {
  assert.throws(() => verifyNativeNoticeVersions(graph('2.3.21 (c)', '1.10.2 (c)')), /Missing selected component/);
});
test('constraints do not create conflicts with actual selected components', () => {
  assert.deepEqual(verifyNativeNoticeVersions(graph() + `+--- ${reflect}:2.2.21 (c)\n\\--- ${coroutines}:1.9.0 (c)\n`), canonical);
});


test('five live Android workflows verify notices against their fresh runtime receipt', () => {
  for (const name of ['ci', 'native-audio-lanes', 'translation-preservation-red', 'translation-selective-wire', 'unsigned-store-build']) {
    const text = readFileSync(new URL('../.github/workflows/' + name + '.yml', import.meta.url), 'utf8');
    const runtime = text.indexOf(':app:dependencyInsight --dependency kotlin-stdlib');
    const verify = text.indexOf('scripts/verify-native-notice-versions.cjs');
    assert.ok(runtime >= 0 && verify > runtime, name + ': missing actual runtime notice verification');
    const receipt = text.slice(runtime).match(/\| tee (\S*app-kotlin-stdlib-runtime\.txt)/)[1];
    assert.ok(text.slice(verify).split('\n')[0].endsWith(' ' + receipt), name + ': verification must consume its own receipt');
    const nextStep = text.indexOf('      - name:', verify);
    assert.ok(nextStep > verify, name + ': verifier is part of the receipt step');
    const stepStart = text.lastIndexOf('      - name:', runtime);
    assert.doesNotMatch(text.slice(stepStart, nextStep), /continue-on-error:\s*true|\|\|\s*true/);
  }
});
