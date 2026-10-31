import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

// GHSA-qr28-fpjm-wq7f: bound replacement scans, without timing or large inputs.
// The optional fixture root is a consumer directory containing real node_modules.
// By default, exercise the installed query-string and its own resolved decoder.
const fixtureRoot = process.env.URI_DECODER_SECURITY_FIXTURE_ROOT;
if (fixtureRoot !== undefined) {
  assert.ok(isAbsolute(fixtureRoot), 'URI_DECODER_SECURITY_FIXTURE_ROOT must be absolute');
}
const consumerRequire = createRequire(fixtureRoot === undefined
  ? import.meta.url
  : pathToFileURL(join(fixtureRoot, 'uri-decoder-security-fixture.cjs')));
const queryEntry = consumerRequire.resolve('query-string');
const decoderEntry = createRequire(queryEntry).resolve('decode-uri-component');
const queryManifest = JSON.parse(readFileSync(join(dirname(queryEntry), 'package.json'), 'utf8'));
const decoderManifest = JSON.parse(readFileSync(join(dirname(decoderEntry), 'package.json'), 'utf8'));
assert.equal(queryManifest.name, 'query-string');
assert.equal(queryManifest.version, '9.5.1', 'exercise the actual 9.5.1 consumer');
assert.equal(decoderManifest.name, 'decode-uri-component');
const { default: queryString } = await import(pathToFileURL(queryEntry).href);
const { default: decode } = await import(pathToFileURL(decoderEntry).href);

const points = Array.from({ length: 256 }, (_, i) => String.fromCodePoint(0x100 + i));
const distinctRuns = points.map(point => encodeURIComponent(point) + 'x').join('') + '%zz';
const distinctExpected = points.map(point => point + 'x').join('') + '%zz';

function measureDecoder(input) {
  const originalReplace = String.prototype.replace;
  let scanned = 0;
  let calls = 0;
  let output;
  // All imports, payload creation, diagnostics and assertions stay outside this
  // synchronous window. Only the real decoder runs with the builtin instrumented.
  try {
    String.prototype.replace = function (...args) {
      scanned += this.length;
      calls++;
      return Reflect.apply(originalReplace, this, args);
    };
    output = decode(input);
  } finally {
    String.prototype.replace = originalReplace;
  }
  return { output, scanned, calls };
}

test('GHSA-qr28-fpjm-wq7f: distinct fallback runs stay within an 8x scan budget', t => {
  const originalReplace = String.prototype.replace;
  const { output, scanned, calls } = measureDecoder(distinctRuns);
  assert.equal(String.prototype.replace, originalReplace);
  assert.equal(output, distinctExpected);
  t.diagnostic(`decode-uri-component ${decoderManifest.version}; query-string ${queryManifest.version}; input=${distinctRuns.length}; replace calls=${calls}; scanned=${scanned}; budget=${8 * distinctRuns.length}`);
  assert.ok(scanned <= 8 * distinctRuns.length,
    `replacement scans ${scanned} exceed 8x input budget ${8 * distinctRuns.length}`);
});

test('fallback decodes once without rescanning newly exposed escapes', () => {
  assert.equal(decode('%2541x%41x%zz'), '%41xAx%zz');
});

test('decoder preserves valid Unicode, emoji, CJK, combining marks and URI literals', () => {
  for (const value of ['', 'plain caption', 'café Ā', '🎬😀', '字幕 日本語', 'e\u0301', '100% + & = / ? #']) {
    assert.equal(decode(encodeURIComponent(value)), value);
  }
  assert.equal(decode('caption+text%2B%20%25'), 'caption+text+ %');
});

test('decoder preserves malformed literals and valid adjacent UTF-8', () => {
  for (const [input, expected] of [
    ['%', '%'], ['%zz', '%zz'], ['%A', '%A'],
    ['%80x%C0%AFx%ED%A0%80x%F4%90%80%80', '%80x%C0%AFx%ED%A0%80x%F4%90%80%80'],
    ['%E4%B8%ADx%F0%9F%98%80x%zz', '中x😀x%zz'],
    ['%FE%FFx%FF%FEx%C2', '\uFFFD\uFFFDx\uFFFD\uFFFDx\uFFFD'],
  ]) {
    assert.equal(decode(input), expected);
  }
});

test('non-string inputs throw TypeError and restore replace on the error path', () => {
  const originalReplace = String.prototype.replace;
  for (const value of [undefined, null, 0, true, {}, [], new String('caption'), Symbol('caption')]) {
    assert.throws(() => measureDecoder(value), TypeError);
    assert.equal(String.prototype.replace, originalReplace);
  }
});

test('query-string 9.5.1 parse/stringify roundtrips realistic caption and link payloads', () => {
  const payloads = [
    { project: 'caption-135', title: '字幕 🎬 café e\u0301', source: 'file:///clips/My clip.mp4', text: '100% + captions & timing=ok', empty: '', flag: null },
    { redirect: 'caption-studio://editor?project=135&cue=2#preview', tag: ['日本語', 'emoji 😀', '%41 + literal'], language: 'zh-CN' },
    { 'caption key + %': 'line one\nline two\t中', cue: ['first', 'second'], empty: '' },
  ];
  for (const payload of payloads) {
    const encoded = queryString.stringify(payload);
    const parsed = queryString.parse(encoded);
    assert.deepEqual({ ...parsed }, payload);
    assert.equal(queryString.stringify(parsed), encoded);
  }
  assert.deepEqual({ ...queryString.parse('text=hello+world%2B%25&empty=&flag') },
    { text: 'hello world+%', empty: '', flag: null });
});

test('query-string 9.5.1 preserves bounded malformed repeats in keys and duplicate values', () => {
  const repeated = '%zzx%80x'.repeat(32);
  const query = `caption=${distinctRuns}&caption=${repeated}&${distinctRuns}=${repeated}`;
  const parsed = queryString.parse(query);
  assert.deepEqual({ ...parsed }, {
    caption: [distinctExpected, repeated],
    [distinctExpected]: repeated,
  });
  assert.deepEqual(queryString.parse(queryString.stringify(parsed)), parsed);
});

test('query-string 9.5.1 does not recursively decode malformed keys or duplicate values', () => {
  const parsed = queryString.parse('%2541x%41x%zz=%2541x%41x%zz&caption=%2541x%41x%zz&caption=%zz');
  assert.deepEqual({ ...parsed }, {
    '%41xAx%zz': '%41xAx%zz',
    caption: ['%41xAx%zz', '%zz'],
  });
  assert.deepEqual(queryString.parse(queryString.stringify(parsed)), parsed);
});
