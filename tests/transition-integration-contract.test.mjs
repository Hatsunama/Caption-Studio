import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createHarness } from './transition-integration-host.mjs';

const recipes = ['crossfade', 'push-left', 'push-right', 'push-up', 'push-down', 'split-horizontal', 'split-vertical', 'iris-circle', 'iris-diamond', 'fold-horizontal', 'fold-vertical', 'zoom-in', 'zoom-out', 'spin'];
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

for (const platform of ['android', 'ios', 'web']) test(`both composite legs use clip audio and equal power: ${platform}`, () => {
  for (const recipe of recipes) for (const reverse of [false, true]) for (const muted of [false, true]) for (const incomingMuted of [false, true]) {
    const h = createHarness(recipe, reverse, platform);
    h.props.entries[0].clip.volume = .8;
    h.props.entries[1].clip.volume = .6;
    h.props.entries[0].clip.muted = muted;
    h.props.entries[1].clip.muted = incomingMuted;
    h.render({ isPlaying: true });
    for (const phase of [0, .25, .5, .75, .999]) {
      h.phase(phase);
      const out = h.players[reverse ? 1 : 0], incoming = h.players[reverse ? 0 : 1];
      near(out.volume, muted ? 0 : .8 * Math.cos(phase * Math.PI / 2));
      near(incoming.volume, incomingMuted ? 0 : .6 * Math.sin(phase * Math.PI / 2));
      assert.equal(out.muted, muted || phase === 1);
      assert.equal(incoming.muted, incomingMuted || phase === 0);
      assert.equal(out.playbackRate, 1); assert.equal(incoming.playbackRate, 1);
      near(out.currentTime, (4500 + phase * 1000) / 1000);
      near(incoming.currentTime, (500 + phase * 1000) / 1000);
    }
    h.unmount();
  }
});

test('composite honors existing user fades on each clip clock', () => {
  const h = createHarness('crossfade');
  h.props.entries[0].clip.fadeOutMs = 1000;
  h.props.entries[1].clip.fadeInMs = 1000;
  h.render({ isPlaying: true }); h.phase(.25);
  near(h.players[0].volume, .25 * Math.cos(Math.PI / 8));
  near(h.players[1].volume, 0);
  h.phase(.75);
  near(h.players[0].volume, 0);
  near(h.players[1].volume, .25 * Math.sin(3 * Math.PI / 8));
  h.unmount();
});

test('authoritative gain endpoints are exact and cover sides remain silent across the cut', () => {
  const h = createHarness('crossfade');
  const { transitionClipPlaybackVolume: gain } = h.load(fileURLToPath(new URL('../src/lib/video-transition-audio.ts', import.meta.url)));
  const window = h.windows[0];
  const [out, incoming] = h.props.entries;
  for (const mode of ['composite', 'cover']) {
    const w = { ...window, mode };
    assert.equal(gain(out, 3500, w), 1); assert.equal(gain(incoming, 3500, w), 0);
    assert.equal(gain(out, 4500, w), 0); assert.equal(gain(incoming, 4500, w), 1);
    if (mode === 'cover') {
      assert.equal(gain(out, 4000, w), 0); assert.equal(gain(incoming, 4000, w), 0);
      assert.equal(gain(incoming, 3750, w), 0); assert.equal(gain(out, 4250, w), 0);
    } else {
      near(gain(out, 4000, w), Math.SQRT1_2); near(gain(incoming, 4000, w), Math.SQRT1_2);
    }
  }
  h.unmount();
});

test('full frame input matte is opaque, inside clipping, outside user transforms; ancestry survives endpoints', () => {
  for (const recipe of recipes) for (const backgroundColor of ['#123456', '#FF000080', '#00FF0000', '#123456FF']) {
    const expected = { '#123456': '#123456', '#FF000080': '#800000', '#00FF0000': '#000000', '#123456FF': '#123456' }[backgroundColor];
    const h = createHarness(recipe);
    h.render({ backgroundColor });
    const ids = h.videos().map(v => v.ancestors.map(n => n.id));
    for (const phase of [0, .5, .999, 1]) {
      h.phase(phase);
      for (const v of h.videos()) {
        assert.equal(v.ancestors[2].style.backgroundColor, undefined, 'elevated outer remains background free');
        assert.equal(v.ancestors[4].style.backgroundColor, expected, 'opaque full input matte prevents outgoing margins at end');
        assert.notEqual(v.ancestors[4].style.transform?.some(t => 'scale' in t), true);
      }
      assert.deepEqual(h.videos().map(v => v.ancestors.map(n => n.id)), ids);
    }
    h.unmount();
  }
});

test('Spin flash reuses Camera flash cover and peak squared above the pair', () => {
  const spin = createHarness('spin'), flash = createHarness('flash');
  for (const phase of [0, .25, .5, .75, .999]) {
    spin.phase(phase); flash.phase(phase);
    const cover = h => h.nodes('view').find(n => n.style.backgroundColor === '#FFFFFF');
    assert.ok(cover(spin), 'spin must include a white flash');
    near(cover(spin).style.opacity, cover(flash).style.opacity);
    assert.equal(cover(spin).ancestors.length, 1, 'flash is a stage sibling above the retained pair');
  }
  spin.unmount(); flash.unmount();
});

test('lost admission, hidden preview and unready transport silence both legs; reentry restores clip mute', () => {
  for (const patch of [{ visible: false }, { transportReady: false }, { admitted: false }]) {
    const h = createHarness('crossfade');
    h.render({ isPlaying: true }); h.phase(.25);
    h.render(patch);
    assert.ok(h.players.every(p => p.muted && !p.playing), 'concealed composite cannot leak either audio leg');
    h.render({ admitted: true, visible: true, transportReady: true });
    assert.ok(h.players.every(p => !p.muted && p.playing), 'reentry explicitly restores both audible legs');
    h.unmount();
  }
 });

for (const reverse of [false, true]) test(`waiting standby keeps only the ordinary muted owner moving, reverse=${reverse}`, () => {
  const h = createHarness('crossfade', reverse);
  try {
    const active = h.props.activeSlot, standby = 1 - active;
    h.props.slots[standby] = { ...h.props.slots[standby], firstFrameReady: false };
    h.render({ isPlaying: true }); h.phase(.25);
    assert.equal(h.players[active].playing, true);
    assert.equal(h.players[standby].playing, false);
    assert.ok(h.players.every(p => p.muted && p.volume === 0));
    assert.ok(h.nodes('text').some(n => n.props.children === 'TRANSITION PREVIEW UNAVAILABLE'));
    assert.ok(h.videos().every(v => v.ancestors.some(n => n.style.opacity === 0)), 'unavailable pair stays concealed');
    const ids = h.videos().map(v => v.id);
    h.render({ isPlaying: false }); assert.ok(h.players.every(p => p.muted && !p.playing));
    h.render({ isPlaying: true }); assert.equal(h.players[active].playing, true);
    h.props.slots[standby] = { ...h.props.slots[standby], firstFrameReady: true };
    h.render();
    assert.ok(h.players.every(p => p.playing && !p.muted), 'initial readiness can complete without a new token');
    assert.deepEqual(h.videos().map(v => v.id), ids);
    h.props.slots[active] = { ...h.props.slots[active], firstFrameReady: false };
    h.render(); assert.ok(h.players.every(p => p.muted && !p.playing), 'unready ordinary owner cannot run');
  } finally { h.unmount(); }
});

for (const reverse of [false, true]) test(`failed render is sticky until actual reprepare and retains frames, reverse=${reverse}`, () => {
  const h = createHarness('crossfade', reverse);
  try {
    h.render({ isPlaying: true }); h.phase(.25);
    const active = h.props.activeSlot, standby = 1 - active;
    const ids = h.videos().map(v => v.id), play = h.players[standby].play;
    let attempts = 0;
    h.players[standby].play = () => { attempts++; throw new Error('render unavailable'); };
    h.players[standby].playing = false;
    h.phase(.3);
    assert.equal(attempts, 1);
    assert.equal(h.players[active].playing, true);
    assert.ok(h.players.every(p => p.muted && p.volume === 0));
    assert.equal(h.players[standby].playing, false);
    for (const phase of [.35, .4, .45]) h.phase(phase);
    h.render({ isPlaying: false }); assert.ok(h.players.every(p => p.muted && !p.playing));
    h.render({ isPlaying: true }); assert.equal(h.players[active].playing, true);
    assert.deepEqual(h.videos().map(v => v.id), ids, 'failed render keeps retained views');
    h.render({ admitted: false }); assert.ok(h.players.every(p => p.muted && !p.playing));
    h.render({ admitted: true });
    assert.equal(h.players[active].playing, true);
    assert.equal(attempts, 1, 'ticks, pause/resume and admission reentry do not retry failed renderer');
    const reentryIds = h.videos().map(v => v.id);
    h.players[standby].play = play;
    h.props.entries[1].clip.muted = true;
    h.props.slots[standby] = { ...h.props.slots[standby], prepareToken: h.props.slots[standby].prepareToken + 1 };
    h.render();
    assert.ok(h.players.every(p => p.playing));
    const incoming = reverse ? 0 : 1;
    assert.equal(h.players[incoming].muted, true); near(h.players[incoming].volume, 0);
    assert.equal(h.players[1 - incoming].muted, false);
    assert.deepEqual(h.videos().map(v => v.id), reentryIds, 'reprepare does not remount native views');
    assert.equal(h.nodes('text').some(n => n.props.children === 'TRANSITION PREVIEW UNAVAILABLE'), false);
  } finally { h.unmount(); }
});
