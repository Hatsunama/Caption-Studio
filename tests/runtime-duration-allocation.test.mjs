import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

// Run with Node --test tests/runtime-duration-allocation.test.mjs (also works through tsx).
// Load the complete real module; only unrelated external imports are stubbed.
// Any accidental dependency call fails loudly rather than supplying fake behavior.
const sourceUrl = new URL('../src/lib/video-timeline.ts', import.meta.url);
const source = readFileSync(sourceUrl, 'utf8');
const importedCallGuards = Object.create(null);
// Strip only module wiring after TypeScript erasure; keep every function body intact.
const executable = stripTypeScriptTypes(source)
  .replace(/^import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"];?\s*$/gm, (_, names, specifier) => {
    for (const name of names.split(',')) {
      const localName = name.trim().split(/\s+as\s+/).at(-1);
      importedCallGuards[localName] = () => {
        throw new Error(`Unexpected dependency call: ${specifier}:${localName}`);
      };
    }
    return '';
  })
  .replace(/^export\s+(?=(?:function|const)\b)/gm, '');
const { totalClipDuration, buildClipTimeline } = vm.runInNewContext(
  `${executable}\n;({ totalClipDuration, buildClipTimeline });`,
  importedCallGuards,
  { filename: sourceUrl.href },
);

function clip(overrides = {}) {
  return {
    sourceStartMs: 0, sourceEndMs: 1000, playbackRate: 1,
    gapBeforeMs: 0, gapAfterMs: 0, ...overrides,
  };
}

function compare(clips, label) {
  assert.equal(totalClipDuration(clips), buildClipTimeline(clips).at(-1)?.afterGapEndMs ?? 0, label);
}

test('duration avoids clips.map and its timeline array/entry allocations', () => {
  const clips = [clip(), clip({ playbackRate: 2, gapBeforeMs: 12.5, gapAfterMs: 0.25 })];
  const expected = buildClipTimeline(clips).at(-1)?.afterGapEndMs ?? 0;
  let mapCalls = 0;
  let mappedEntries = 0;
  Object.defineProperty(clips, 'map', {
    value(callback, thisArg) {
      mapCalls += 1;
      const result = Array.prototype.map.call(this, callback, thisArg);
      mappedEntries += result.length;
      return result;
    },
  });
  assert.equal(totalClipDuration(clips), expected);
  assert.deepEqual({ mapCalls, mappedEntries }, { mapCalls: 0, mappedEntries: 0 });
});

test('duration does not request an Array species allocation', () => {
  const clips = [clip()];
  Object.defineProperty(clips, 'constructor', {
    get() { throw new Error('Timeline array allocation requested'); },
  });
  assert.equal(totalClipDuration(clips), 1000);
});

test('fractions, rates, gaps, reversed bounds and invalid numeric fields match the timeline', () => {
  compare([], 'empty');
  const values = [0, -0, 0.1, 1 / 3, 0.25, 4, -12.5, 1e-300, 1e20,
    Number.MAX_VALUE, NaN, Infinity, -Infinity, undefined, null, '12'];
  for (const field of ['sourceStartMs', 'sourceEndMs', 'playbackRate', 'gapBeforeMs', 'gapAfterMs']) {
    for (const value of values) {
      compare([clip({ gapBeforeMs: 0.1 }), clip({ [field]: value }), clip({ gapAfterMs: 1 / 3 })],
        `${field}=${String(value)}`);
    }
  }
  compare([clip({ sourceStartMs: 10, sourceEndMs: -10 })], 'reversed bounds');
  compare([clip({ sourceStartMs: Infinity, sourceEndMs: Infinity })], 'NaN source difference');
  compare([clip({ sourceEndMs: Number.MAX_VALUE }), clip({ sourceEndMs: Number.MAX_VALUE })], 'overflow');

  // These values distinguish sequential additions from cursor += before + duration + after.
  const rounding = [clip({ sourceEndMs: 1e16 }), clip({ sourceEndMs: 1, gapBeforeMs: 1, gapAfterMs: 1 })];
  assert.equal(buildClipTimeline(rounding).at(-1).afterGapEndMs, 1e16);
  compare(rounding, 'floating-point addition order');
});

test('deterministic mixed fractional timelines match exactly without mutating clips', () => {
  let state = 0x55e3fa0f;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
  for (let run = 0; run < 200; run += 1) {
    const clips = Array.from({ length: run % 31 }, () => Object.freeze(clip({
      sourceStartMs: random() * 1000, sourceEndMs: random() * 10000,
      playbackRate: random() * 6 - 1,
      gapBeforeMs: random() * 100 - 10, gapAfterMs: random() * 100 - 10,
    })));
    compare(Object.freeze(clips), `mixed run ${run}`);
  }
});

test('sparse arrays preserve map hole skipping and final-hole zero result', () => {
  compare(new Array(4), 'all holes');
  compare([, clip(), , clip({ gapBeforeMs: 0.1 })], 'leading and interior holes');
  const trailing = [clip()];
  trailing.length = 3;
  compare(trailing, 'trailing holes');
  const poisoned = [clip({ sourceEndMs: NaN })];
  poisoned.length = 2;
  compare(poisoned, 'NaN cursor with trailing hole');
  const inherited = new Array(3);
  const prototype = Object.create(Array.prototype);
  prototype[2] = clip({ gapAfterMs: 0.2 });
  Object.setPrototypeOf(inherited, prototype);
  compare(inherited, 'inherited numeric slot');
});

test('malformed present entries still throw, including before a trailing hole', () => {
  for (const value of [undefined, null]) {
    const clips = [value];
    clips.length = 2;
    assert.throws(() => buildClipTimeline(clips), { name: 'TypeError' });
    assert.throws(() => totalClipDuration(clips), { name: 'TypeError' });
  }
});

