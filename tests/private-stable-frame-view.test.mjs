import assert from 'node:assert/strict';
import test from 'node:test';
import { privateFramePtsTarget as map, privateStableViewExperiment as probe } from '../src/components/editor/private-frame-pts-diagnostic.ts';

const fixture = { displayName: 'cs-stable-frame-samsung.mp4', durationMs: 8000, width: 360, height: 640 };

test('stable-view gate and literal PTS mapping accept only the new paired fixtures and exact profile', () => {
  for (const displayName of [fixture.displayName, 'cs-stable-frame-seeker.mp4']) {
    const source = { ...fixture, displayName };
    for (const target of [6.380, 6.385416, 6.390]) {
      assert.equal(probe(source, target, 8, 'android', false), true);
      assert.equal(map(target, source, 8, 'android', false), 6.375);
    }
  }
  for (const delta of [{ displayName: 'other.mp4' }, { displayName: 'CS-stable-frame-samsung.mp4' },
    { displayName: 'cs-stable-frame-samsung.mp4.bak' }, { durationMs: '8000' }, { durationMs: 7999 },
    { width: '360' }, { width: 640 }, { height: '640' }, { height: 360 }]) {
    const source = { ...fixture, ...delta };
    assert.equal(probe(source, 6.385416, 8, 'android', false), false);
    assert.equal(map(6.385416, source, 8, 'android', false), 6.385416);
  }
  for (const duration of ['8', 7.999, NaN, undefined]) {
    assert.equal(probe(fixture, 6.385416, duration, 'android', false), false);
    assert.equal(map(6.385416, fixture, duration, 'android', false), 6.385416);
  }
  for (const platform of ['ios', 'web', 'windows']) {
    assert.equal(probe(fixture, 6.385416, 8, platform, false), false);
    assert.equal(map(6.385416, fixture, 8, platform, false), 6.385416);
  }
  assert.equal(probe(fixture, 6.385416, 8, 'android', true), false);
  assert.equal(map(6.385416, fixture, 8, 'android', true), 6.385416);
  for (const target of [0, 6.375, 6.379999, 6.390001, 8, Infinity, NaN]) {
    assert.equal(probe(fixture, target, 8, 'android', false), false);
    assert.ok(Object.is(map(target, fixture, 8, 'android', false), target));
  }
});

test('ordinary cs-166 fixtures retain literal mapping and explicitly reject the stable-view bypass', () => {
  for (const displayName of ['cs-166-samsung.mp4', 'cs-166-seeker.mp4']) {
    const source = { ...fixture, displayName };
    assert.equal(probe(source, 6.385416, 8, 'android', false), false);
    assert.equal(map(6.385416, source, 8, 'android', false), 6.375);
  }
});
