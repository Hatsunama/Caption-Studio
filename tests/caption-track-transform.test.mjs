import assert from 'node:assert/strict';
import test from 'node:test';
import { createCaptionProject } from '../src/lib/project-factory.ts';
import { applyStylePatch, resolveCaptionStyle } from '../src/lib/style-resolver.ts';
import { createTranslationCaptionTrack, resolveCaptionPairs, setTranslationCueStyle, setTranslationTrackStyle } from '../src/lib/caption-tracks.ts';
import { captionTransform, hasCaptionTransform } from '../src/lib/caption-transform.ts';
import { captionPreviewState } from '../src/lib/caption-preview.ts';
import { decodeVersionTwoProject, serializeProjectSnapshot } from '../src/lib/project-schema.ts';
import { buildTimelineRenderPlan } from '../src/lib/export-render-plan.ts';

function fixture() {
  let p = createCaptionProject({ id: 'track-test', name: 'Tracks', sources: [{ id: 'video',
    uri: 'file:///test.mp4', storageMode: 'copied', displayName: 'Video', durationMs: 5000,
    width: 1080, height: 1920, rotation: 0, frameRate: 30 }] });
  p.projectStyle = { ...p.projectStyle, position: { x: 0.5, y: 0.4 } };
  p.captions = [0, 1000, 3000].map((startMs, i) => ({ id: `c${i}`, text: `Caption ${i}`,
    startMs, endMs: startMs + 1000, wordIds: [`w${i}`], styleOverride: {
      textColor: '#123456', rotation: i * 20, position: { x: 0.2 + i * 0.1 }, scale: i + 1,
    } }));
  p.transcription.words = p.captions.map((c, i) => ({ id: `w${i}`, text: c.text,
    startMs: c.startMs, endMs: c.endMs, styleOverride: { italic: true, scaleX: 2 } }));
  p.layers.push({ id: 'title', kind: 'text', name: 'Title', text: 'Unrelated', visible: true,
    startMs: 0, endMs: 5000, style: structuredClone(p.projectStyle) });
  p.layers.push({ id: 'logo', kind: 'image', name: 'Logo', uri: 'file:///logo.png', visible: true,
    startMs: 0, endMs: 5000, ...captionTransform(p.projectStyle), opacity: 1 });
  for (const language of ['fr', 'de']) p = createTranslationCaptionTrack(p, {
    id: language, languageTag: language, displayName: language,
    translations: Object.fromEntries(p.captions.map((cue) => [cue.id, `${language} ${cue.text}`])),
  });
  p.captionTracks.translations[0].cues[1].startMs = 1500;
  p.captionTracks.translations[0].cues[1].endMs = 2500;
  return p;
}
const geometry = { position: { x: 0.3, y: 0.2 }, box: { width: 0.7, height: 0.16 },
  rotation: 37, scale: 1.3, scaleX: 0.8, scaleY: 1.7 };
const primaryGeometry = (p) => p.captions.map((c) => captionTransform(resolveCaptionStyle(p.projectStyle, c)));
const secondaryGeometry = (p, id) => resolveCaptionPairs(p, id).map((pair) => captionTransform(pair.style));
const content = (p) => p.captions.map(({ styleOverride, ...cue }) => cue);

test('primary cue transforms atomically own the entire track, including hidden cues and words', () => {
  const before = fixture();
  before.captions[2].timelineVisible = false;
  const untouched = structuredClone(before);
  const next = applyStylePatch(before, 'c1', 'caption', geometry);
  assert.deepEqual(primaryGeometry(next), [geometry, geometry, geometry]);
  for (const word of next.transcription.words) assert.equal(hasCaptionTransform(word.styleOverride), false);
  assert.deepEqual(content(next), content(before));
  assert.equal(next.layers, before.layers);
  for (const id of ['fr', 'de']) assert.deepEqual(secondaryGeometry(next, id), secondaryGeometry(before, id));
  assert.deepEqual(before, untouched);
  assert.equal(next.captions[1].styleOverride.textColor, '#123456');
  assert.equal(next.transcription.words[1].styleOverride.italic, true);
});

test('partial transform from a cue propagates its complete geometry, while text styling stays cue-local', () => {
  const before = fixture();
  const next = applyStylePatch(before, 'c1', 'caption', { position: { y: 0.1 }, textColor: '#FFFFFF' });
  const expected = { ...captionTransform(resolveCaptionStyle(before.projectStyle, before.captions[1])),
    position: { x: 0.3, y: 0.1 } };
  for (const actual of primaryGeometry(next)) {
    assert.ok(Math.abs(actual.position.x - expected.position.x) < 1e-12);
    assert.deepEqual({ ...actual, position: expected.position }, expected);
  }
  assert.equal(next.captions[0].styleOverride.textColor, '#123456');
  assert.equal(next.captions[1].styleOverride.textColor, '#FFFFFF');
});

for (const scope of ['cue', 'track']) test(`${scope} translation geometry propagates without changing primary, other languages or timing`, () => {
  const before = fixture();
  before.captionTracks.translations[0].cues[2].styleOverride = { rotation: -42, scaleX: 3, italic: true };
  const next = scope === 'cue' ? setTranslationCueStyle(before, 'fr', 'c1', geometry)
    : setTranslationTrackStyle(before, 'fr', geometry);
  assert.deepEqual(secondaryGeometry(next, 'fr'), [geometry, geometry, geometry]);
  assert.equal(next.captions, before.captions);
  assert.equal(next.layers, before.layers);
  assert.deepEqual(secondaryGeometry(next, 'de'), secondaryGeometry(before, 'de'));
  for (let i = 0; i < 3; i++) {
    const { styleOverride: oldStyle, ...oldCue } = before.captionTracks.translations[0].cues[i];
    const { styleOverride: newStyle, ...newCue } = next.captionTracks.translations[0].cues[i];
    assert.deepEqual(newCue, oldCue);
  }
});

test('legacy translation layout is anchored on reopen and remains independent across later primary edits', () => {
  const before = fixture();
  for (const track of before.captionTracks.translations) delete track.layoutAnchor;
  const reopened = decodeVersionTwoProject(JSON.parse(serializeProjectSnapshot(before)));
  assert.ok(reopened.captionTracks.translations.every((track) => track.layoutAnchor));
  const next = applyStylePatch(reopened, 'c0', 'caption', geometry);
  for (const id of ['fr', 'de']) assert.deepEqual(secondaryGeometry(next, id), secondaryGeometry(reopened, id));
  const legacyEdited = applyStylePatch(before, 'c0', 'caption', geometry);
  for (const id of ['fr', 'de']) assert.deepEqual(secondaryGeometry(legacyEdited, id), secondaryGeometry(before, id));
});

test('serialized/reopened preview and export have identical track geometry and independent text/timing', () => {
  let project = applyStylePatch(fixture(), 'c1', 'caption', geometry);
  const secondary = { ...geometry, rotation: -19, position: { x: 0.6, y: 0.7 } };
  project = setTranslationCueStyle(project, 'fr', 'c2', secondary);
  const reopened = decodeVersionTwoProject(JSON.parse(serializeProjectSnapshot(project)));
  assert.deepEqual(primaryGeometry(reopened), primaryGeometry(project));
  assert.deepEqual(secondaryGeometry(reopened, 'fr'), secondaryGeometry(project, 'fr'));
  const plan = buildTimelineRenderPlan(reopened);
  for (const cue of reopened.captions) {
    const exported = plan.captions.find((c) => c.id === cue.id);
    assert.deepEqual(captionTransform(exported.style), geometry);
    for (const word of exported.words) assert.deepEqual(captionTransform(word.style), geometry);
    assert.equal(exported.text, cue.text);
    assert.equal(exported.startMs, cue.startMs);
    assert.equal(exported.endMs, cue.endMs);
  }
  for (const pair of resolveCaptionPairs(reopened, 'fr')) {
    const exported = plan.captions.find((c) => c.id === pair.translation.id);
    assert.deepEqual(captionTransform(exported.style), secondary);
    assert.equal(exported.startMs, pair.startMs);
    assert.equal(exported.endMs, pair.endMs);
    assert.equal(exported.text, pair.translation.text);
  }
});

test('fixed-playhead content is independent of repeated non-active selection, gaps and hidden cues', () => {
  const p = fixture();
  const snapshot = serializeProjectSnapshot(p);
  for (const id of ['c2', 'c1', 'c1', undefined, 'missing', 'c0', 'c2']) {
    const state = captionPreviewState(p.captions, 500, id);
    assert.equal(state.active, p.captions[0]);
    assert.equal(state.selected?.id, p.captions.find((c) => c.id === id)?.id);
  }
  assert.equal(captionPreviewState(p.captions, 2500, 'c2').active, undefined);
  assert.equal(captionPreviewState(p.captions, 1000, 'c0').active.id, 'c1');
  assert.equal(serializeProjectSnapshot(p), snapshot);
});

test('translated All scope clears exactly matching cue style overrides, including nested font identity', () => {
  let p = fixture();
  p = setTranslationCueStyle(p, 'fr', 'c0', { textColor: '#FF0000', fontSize: 90,
    animation: { id: 'fade-in', durationMs: 999 }, italic: true,
    font: { id: 'imported', family: 'Custom', source: 'imported', uri: 'file:///font.otf' } });
  const next = setTranslationTrackStyle(p, 'fr', { textColor: '#00FF00', fontSize: 24,
    animation: { id: 'none' }, font: { id: 'system', family: 'serif', source: 'system' } });
  const pairs = resolveCaptionPairs(next, 'fr');
  for (const pair of pairs) {
    assert.equal(pair.style.textColor, '#00FF00');
    assert.equal(pair.style.fontSize, 24);
    assert.equal(pair.style.animation.id, 'none');
    assert.equal(pair.style.font.uri, undefined);
  }
  assert.equal(pairs[0].style.italic, true);
  assert.equal(pairs[0].style.animation.durationMs, 999);
  assert.deepEqual(secondaryGeometry(next, 'de'), secondaryGeometry(p, 'de'));
});

test('preview and export include every overlapping active cue in the same order', () => {
  const p = fixture();
  p.captions[1].startMs = 500;
  const preview = captionPreviewState(p.captions, 750, 'c2');
  const exported = buildTimelineRenderPlan(p).captions.filter((cue) => !cue.id.includes(':')
    && cue.startMs <= 750 && cue.endMs > 750);
  assert.deepEqual(preview.activeCaptions.map((cue) => cue.id), exported.map((cue) => cue.id));
  assert.deepEqual(preview.activeCaptions.map((cue) => cue.id), ['c0', 'c1']);
  assert.equal(preview.selected.id, 'c2');
});
