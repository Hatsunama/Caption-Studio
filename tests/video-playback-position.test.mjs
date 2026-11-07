import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as policy from '../src/lib/video-playback-position.ts';
import { buildClipTimeline, sourceTimeAt } from '../src/lib/video-timeline.ts';
const { acknowledgesPlaybackPosition: ack } = policy;

test('precision policy follows the installed Expo 57 native conversions', () => {
  const base = new URL('../node_modules/expo-video/', import.meta.url);
  const module = readFileSync(new URL('android/src/main/java/expo/modules/video/VideoModule.kt', base), 'utf8');
  const player = readFileSync(new URL('android/src/main/java/expo/modules/video/player/VideoPlayer.kt', base), 'utf8');
  const ios = readFileSync(new URL('ios/VideoPlayer.swift', base), 'utf8');
  assert.match(module, /ref\.player\.currentPosition \/ 1000f/);
  assert.match(module, /seekTo\(\(currentTime \* 1000\)\.toLong\(\)\)/);
  assert.match(player, /TimeUpdate\(player\.currentPosition \/ 1000\.0/);
  assert.match(player, /duration = player\.duration \/ 1000f/);
  assert.match(ios, /CMTimeMakeWithSeconds\(clampedTime, preferredTimescale: \.max\)/);
});

test('Android accepts Long-ms and native Float getter precision, rejecting unrelated nearby positions', () => {
  for (const milliseconds of [0, 1, 6385.416, 22800.875, 3600000.25, 123456789.75]) {
    const target = milliseconds / 1000;
    const nativeMs = Math.trunc(target * 1000);
    for (const receipt of [target, nativeMs / 1000, Math.fround(Math.fround(nativeMs) / 1000)]) {
      assert.equal(ack(receipt, target, 'android'), true, `${milliseconds}: ${receipt}`);
    }
    assert.equal(ack(target + .115, target, 'android'), false);
    assert.equal(ack(target - .115, target, 'android'), false);
  }
  for (const receipt of [6.384, 6.386, 6.417, 6.5]) assert.equal(ack(receipt, 6.385416, 'android'), false);
});

test('Android EOF compatibility normalizes the request rather than widening ACK', () => {
  for (const receipt of [7.999, Math.fround(7.999), 7.998, 8.001, 8.036]) assert.equal(ack(receipt, 8, 'android'), false);
  assert.equal(ack(8, 8, 'android'), true);
  assert.equal(ack(7.999, 8, 'android'), false, 'trim endpoint is not media EOF');
  assert.equal(ack(6.384416, 6.385416, 'android'), false);
});

test('iOS and web retain the prior inclusive 250ms ACK window', () => {
  for (const target of [0, .123456789, 6.385416, 22.8, 3600.123456]) {
    const iosReceipt = Math.round(target * 0x7fffffff) / 0x7fffffff;
    assert.equal(ack(iosReceipt, target, 'ios'), true);
    assert.equal(ack(target, target, 'web'), true);
    for (const platform of ['ios', 'web']) {
      for (const delta of [-.25, -.115, .115, .25]) assert.equal(ack(target + delta, target, platform), true);
      for (const delta of [-.251, .251]) assert.equal(ack(target + delta, target, platform), false);
    }
  }
});

test('nonfinite positions or targets never acknowledge preparation', () => {
  for (const platform of ['android', 'ios', 'web']) for (const value of [NaN, Infinity, -Infinity]) {
    assert.equal(ack(value, 8, platform), false);
    assert.equal(ack(8, value, platform), false);
  }
});

test('whole-media native target uses loaded duration and the last millisecond within 250ms', () => {
  const target = policy.effectiveNativeSeekTarget;
  for (const duration of [7.95, Math.fround(7.95)]) assert.equal(target(8, 8, duration, 'android'), 7.949);
  assert.equal(target(8, 8, 8, 'android'), 7.999);
  assert.equal(target(8, 8, 7.999, 'android'), 7.998);
  assert.equal(target(8, 8, 7.751, 'android'), 7.75);
  for (const duration of [7.75, 7.749, 6, 0, -1, NaN, Infinity, undefined, 8.001, 9]) {
    assert.equal(target(8, 8, duration, 'android'), 8, `duration ${duration}`);
  }
  assert.equal(target(6.385, 8, 6.386, 'android'), 6.385, 'trim endpoint');
  assert.equal(target(7.999, 8, 8, 'android'), 7.999, 'body position');
  for (const platform of ['ios', 'web']) assert.equal(target(8, 8, 7.95, platform), 8);
});

test('Float duration recovery preserves native integer milliseconds without widening the EOF bound', () => {
  const target = policy.effectiveNativeSeekTarget;
  for (const milliseconds of [1002, 7950, 7999, 8000, 16777215]) {
    const duration = Math.fround(Math.fround(milliseconds) / 1000);
    const effective = target(milliseconds / 1000, milliseconds / 1000, duration, 'android');
    assert.equal(Math.trunc(effective * 1000), milliseconds - 1);
    assert.equal(ack((milliseconds - 1) / 1000, effective, 'android'), true);
  }
  assert.equal(target(8, 8, Math.fround(7.75), 'android'), 8);
  assert.equal(target(8, 8, Math.fround(7.751), 'android'), 7.75);
});

test('actual rate and gap arithmetic still identifies whole-media EOF without treating a trim as EOF', () => {
  for (const [rate, gap] of [[.75, 1000.25], [1.5, 500], [1.5, 1000.25]]) {
    const clip = { id: 'clip', sourceId: 'source', sourceStartMs: 0, sourceEndMs: 1001,
      playbackRate: rate, gapBeforeMs: gap, gapAfterMs: 0, volume: 1, muted: false,
      fadeInMs: 0, fadeOutMs: 0, transitionAfter: { type: 'none', durationMs: 0 } };
    const entry = buildClipTimeline([clip])[0];
    const requested = sourceTimeAt(entry, entry.endMs) / 1000;
    assert.notEqual(requested, 1.001, 'fixture must retain the demonstrated arithmetic noise');
    const effective = policy.effectiveNativeSeekTarget(requested, 1.001, 1.001, 'android');
    assert.equal(Math.trunc(effective * 1000), 1000, 'seek inside the loaded item at media EOF');
    assert.equal(ack(1, effective, 'android'), true);
    assert.equal(policy.effectiveNativeSeekTarget(1.000999, 1.001, 1.001, 'android'), 1.000999,
      'a genuine sub-ms trim must remain a trim');
  }
});
