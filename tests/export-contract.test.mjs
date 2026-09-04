import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTimelineRenderPlan,
  collectUnresolvedFontFamilies,
  toNativeRenderPlan,
} from '../src/lib/export-render-plan.ts';
import { serializeAss, serializeSrt } from '../src/lib/subtitle-export.ts';
import {
  createEnglishChineseCaptionTrack,
  setTranslationTrackVisibility,
} from '../src/lib/caption-tracks.ts';
import {
  createVideoExportSession,
  VideoExportCancelledError,
} from '../src/services/video-export-session.ts';
import { DEFAULT_CAPTION_STYLE } from '../src/types/project.ts';

test('render plans are pure, detached, inherited, and exclude trim-hidden content', () => {
  const project = exportProject({
    projectStyle: style({
      font: { id: 'anton', family: 'Caption-Anton', source: 'built-in', postScriptName: 'Anton' },
      textColor: '#FFFFFF',
    }),
    transcription: {
      language: 'en',
      modelId: 'fast',
      sourceResults: {},
      words: [
        { id: 'visible-word', text: 'Visible', startMs: -50, endMs: 900, styleOverride: { textColor: '#00FF00' } },
        { id: 'hidden-word', text: 'Hidden', startMs: 1_000, endMs: 1_500 },
      ],
    },
    captions: [
      {
        id: 'visible-caption',
        text: 'Visible',
        startMs: -100,
        endMs: 5_000,
        timelineVisible: true,
        wordIds: ['visible-word'],
        styleOverride: { fontSize: 64 },
      },
      {
        id: 'trim-hidden-caption',
        text: 'Hidden',
        startMs: 1_000,
        endMs: 1_500,
        timelineVisible: false,
        wordIds: ['hidden-word'],
      },
    ],
    layers: [
      { id: 'captions', kind: 'captions', name: 'Captions', visible: true },
      {
        id: 'visible-title', kind: 'text', name: 'Title', visible: true, timelineVisible: true,
        text: 'Title', startMs: -20, endMs: 5_000, style: style({ fontSize: 40 }),
      },
      {
        id: 'trim-hidden-title', kind: 'text', name: 'Hidden title', visible: true, timelineVisible: false,
        text: 'Never render', startMs: 0, endMs: 4_000,
        style: style({ font: { id: 'bungee', family: 'Caption-Bungee', source: 'built-in' } }),
      },
      {
        id: 'trim-hidden-sticker', kind: 'image', name: 'Hidden sticker', visible: true, timelineVisible: false,
        uri: 'content://hidden.png', startMs: 0, endMs: 4_000,
        position: { x: 0.5, y: 0.5 }, box: { width: 0.3, height: 0.3 }, rotation: 0, opacity: 1,
      },
    ],
  });
  const before = structuredClone(project);
  const plan = buildTimelineRenderPlan(project, new Map([['Caption-Anton', 'file:///resolved-anton.ttf']]));

  assert.deepEqual(project, before);
  assert.deepEqual(plan.captions.map((caption) => caption.id), ['visible-caption']);
  assert.deepEqual(plan.layers.map((layer) => layer.id), ['captions', 'visible-title']);
  assert.deepEqual([plan.captions[0].startMs, plan.captions[0].endMs], [0, 4_000]);
  assert.deepEqual([plan.layers[1].startMs, plan.layers[1].endMs], [0, 4_000]);
  assert.equal(plan.captions[0].style.fontSize, 64);
  assert.equal(plan.captions[0].style.font.uri, 'file:///resolved-anton.ttf');
  assert.equal(plan.captions[0].words[0].style.textColor, '#00FF00');
  assert.deepEqual(collectUnresolvedFontFamilies(buildTimelineRenderPlan(project)).sort(), ['Caption-Anton']);

  project.projectStyle.position.x = 0;
  project.videoTransform.position.x = 0;
  assert.equal(plan.captions[0].style.position.x, 0.5);
  assert.equal(plan.videoTransform.position.x, 0.5);
});

test('SRT and ASS preserve visible Unicode multiline captions and nonzero timing', () => {
  const project = exportProject({
    canvas: { preset: '16:9', aspectWidth: 16, aspectHeight: 9, backgroundColor: '#000000' },
    projectStyle: style({
      font: { id: 'anton', family: 'Caption-Anton', source: 'built-in', postScriptName: 'Anton' },
      fontSize: 48,
      alignment: 'center',
      shadow: { ...DEFAULT_CAPTION_STYLE.shadow, offsetX: -2, offsetY: 3, blur: 5 },
    }),
    transcription: {
      language: 'en', modelId: 'fast', sourceResults: {},
      words: [
        { id: 'bright', text: 'Bright', startMs: 1_000, endMs: 1_400 },
        { id: 'world', text: 'world', startMs: 1_400, endMs: 2_000, styleOverride: { fontSize: 72, textColor: '#00FF00' } },
      ],
    },
    captions: [
      { id: 'unicode', text: 'Café 👋\r\n世界', startMs: -20, endMs: 5, timelineVisible: true, wordIds: [] },
      { id: 'styled', text: 'Bright\nworld', startMs: 1_000, endMs: 2_000, timelineVisible: true, wordIds: ['bright', 'world'] },
      { id: 'hidden', text: 'NEVER EXPORT', startMs: 500, endMs: 800, timelineVisible: false, wordIds: [] },
    ],
  });

  const srt = serializeSrt(project);
  assert.match(srt, /00:00:00,000 --> 00:00:00,005\nCafé 👋\n世界/);
  assert.doesNotMatch(srt, /NEVER EXPORT/);

  const ass = serializeAss(project);
  assert.match(ass, /PlayResX: 1920\nPlayResY: 1080/);
  assert.match(ass, /Dialogue: 0,0:00:00\.00,0:00:00\.01/);
  assert.match(ass, /Café 👋\\N世界/);
  assert.match(ass, /\\fnAnton\\fs256/);
  assert.match(ass, /\\an5\\pos\(960,842\)/);
  assert.match(ass, /\\xshad-10\.67\\yshad16\\blur26\.67/);
  assert.match(ass, /\\fs384[^}]*\\c&H0000FF00&/);
  assert.doesNotMatch(ass, /NEVER EXPORT/);
});


test('render plans omit undefined keys so Expo can convert them to Kotlin maps', () => {
  const project = exportProject({
    captions: [{ id: 'c1', text: 'Hello', startMs: 0, endMs: 1_000, wordIds: [] }],
    audioSources: [{
      id: 'audio', uri: 'file:///extracted.m4a', storageMode: 'copied', displayName: 'Extracted',
      durationMs: 4_000, origin: 'video-audio',
    }],
    audioClips: [{
      id: 'ac1', sourceId: 'audio', anchor: 'timeline', startMs: 0,
      sourceStartMs: 0, sourceEndMs: 4_000, volume: 1, muted: false, fadeInMs: 0, fadeOutMs: 0,
    }],
  });
  const plan = buildTimelineRenderPlan(project);
  assert.equal('backgroundReplacement' in plan, false);
  assert.equal('uri' in plan.captions[0].style.font, false);
  assert.equal('postScriptName' in plan.captions[0].style.font, false);
  assert.deepEqual(Object.keys(plan.audioClips[0]).sort(), [
    'fadeInMs', 'fadeOutMs', 'id', 'muted', 'sourceEndMs', 'sourceStartMs', 'startMs', 'uri', 'volume',
  ]);
  assert.equal(plan.audioClips[0].uri, 'file:///extracted.m4a');
  assertNoUndefined(plan, 'plan');
  const native = toNativeRenderPlan(plan);
  assert.equal('backgroundReplacement' in native, false);
  assert.deepEqual(JSON.parse(JSON.stringify(native)), native);
});

function assertNoUndefined(value, path) {
  if (value === undefined) assert.fail(`${path} is undefined`);
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoUndefined(item, `${path}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    assertNoUndefined(child, `${path}.${key}`);
  }
}

test('optional dual captions share timing and export as two styled lines without changing single-language output', () => {
  const single = exportProject({
    transcription: { language: 'en', modelId: 'fast', sourceResults: {}, words: [] },
    captions: [{ id: 'c1', text: 'Make it feel natural.', startMs: 500, endMs: 2_000, wordIds: [] }],
  });
  const singleSrt = serializeSrt(single);
  const bilingual = createEnglishChineseCaptionTrack(single, { c1: '要翻得自然。' }, {
    origin: 'automatic',
    provider: {
      id: 'litertlm',
      modelId: 'qwen2.5-1.5b-q8',
      modelRevision: '19edb84c69a0212f29a6ef17ba0d6f278b6a1614',
      promptVersion: 1,
    },
  });
  const plan = buildTimelineRenderPlan(bilingual);

  assert.equal(plan.captions.length, 2);
  assert.deepEqual(plan.captions.map((caption) => [caption.text, caption.startMs, caption.endMs]), [
    ['Make it feel natural.', 500, 2_000],
    ['要翻得自然。', 500, 2_000],
  ]);
  assert.equal(plan.captions[1].words.length, 0);
  assert.equal(plan.captions[1].style.font.family, 'sans-serif');
  assert.notEqual(plan.captions[1].style.position.y, plan.captions[0].style.position.y);
  assert.match(serializeSrt(bilingual), /Make it feel natural\.\n要翻得自然。/);
  assert.match(serializeAss(bilingual), /Dialogue: 0,[^\n]*Make it feel natural\./);
  assert.match(serializeAss(bilingual), /Dialogue: 1,[^\n]*要翻得自然。/);

  const hidden = setTranslationTrackVisibility(bilingual, bilingual.captionTracks.translations[0].id, false);
  assert.equal(serializeSrt(hidden), singleSrt);
  assert.deepEqual(buildTimelineRenderPlan(hidden).captions.map((caption) => caption.text), ['Make it feel natural.']);
});

test('visible pending or stale translations block final exports instead of silently omitting a language', () => {
  const project = createEnglishChineseCaptionTrack(exportProject({
    transcription: { language: 'en', modelId: 'fast', sourceResults: {}, words: [] },
    captions: [{ id: 'c1', text: 'Still waiting', startMs: 0, endMs: 1_000, wordIds: [] }],
  }));
  assert.throws(() => buildTimelineRenderPlan(project), /need translation/);
  assert.throws(() => serializeSrt(project), /need translation/);
  assert.throws(() => serializeAss(project), /need translation/);
});

test('pre-native cancellation rejects immediately and never starts the native exporter', async () => {
  let nativeStarts = 0;
  let nativeCancellations = 0;
  const preparation = deferred();
  const session = createVideoExportSession(async () => { nativeCancellations += 1; });
  const exporting = session.run(async (context) => {
    await context.waitFor(preparation.promise);
    return context.startNative(async () => {
      nativeStarts += 1;
      return 'done';
    });
  });

  await Promise.resolve();
  assert.equal(await session.cancel(), true);
  await assert.rejects(exporting, VideoExportCancelledError);
  preparation.resolve('prepared');
  assert.equal(nativeStarts, 0);
  assert.equal(nativeCancellations, 0);
});

test('native-stage cancellation is forwarded once and the session can be reused', async () => {
  let nativeCancellations = 0;
  const native = deferred();
  const session = createVideoExportSession(async () => { nativeCancellations += 1; });
  const exporting = session.run((context) => context.startNative(() => native.promise));
  await Promise.resolve();
  assert.equal(await session.cancel(), true);
  assert.equal(await session.cancel(), false);
  native.resolve('late success');
  await assert.rejects(exporting, VideoExportCancelledError);
  assert.equal(nativeCancellations, 1);
  assert.equal(await session.run(async () => 'next export'), 'next export');
});

function exportProject(overrides = {}) {
  const base = {
    schemaVersion: 2,
    id: 'export-project',
    name: 'Export project',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lifecycle: { status: 'saved' },
    sources: [{
      id: 'source', uri: 'content://video.mp4', storageMode: 'linked', displayName: 'Video',
      durationMs: 4_000, width: 1080, height: 1920, rotation: 0,
    }],
    transcription: { language: 'en', modelId: 'fast', words: [], sourceResults: {} },
    captions: [],
    captionTracks: { schemaVersion: 1, primaryTrackId: 'captions', translations: [] },
    projectStyle: style(),
    layers: [{ id: 'captions', kind: 'captions', name: 'Captions', visible: true }],
    clips: [{
      id: 'clip', sourceId: 'source', availableSourceStartMs: 0, availableSourceEndMs: 4_000,
      sourceStartMs: 0, sourceEndMs: 4_000, gapBeforeMs: 0, gapAfterMs: 0,
      playbackRate: 1, volume: 1, muted: false, fadeInMs: 0, fadeOutMs: 0,
      transitionAfter: { type: 'none', durationMs: 0 },
    }],
    audioSources: [],
    audioClips: [],
    canvas: { preset: 'source', aspectWidth: 9, aspectHeight: 16, backgroundColor: '#000000' },
    videoTransform: { fit: 'fit', position: { x: 0.5, y: 0.5 }, scale: 1, rotation: 0 },
    backgroundReplacement: {
      enabled: false,
      mask: { qualityPreset: 'stable', threshold: 0.46, softness: 0.14, temporalStability: 0.78, edgeFeather: 0.45 },
      personTransform: { position: { x: 0.5, y: 0.5 }, scale: 1, rotation: 0 },
      keyframes: [],
    },
    export: { resolution: '1080p', format: 'mp4', burnCaptions: true },
  };
  return { ...base, ...overrides };
}

function style(overrides = {}) {
  return {
    ...structuredClone(DEFAULT_CAPTION_STYLE),
    ...overrides,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

// Release regressions: translation completion and export visibility are behavioral contracts.
import { automaticTranslationCueWrites } from '../src/lib/caption-translation-commit.ts';
import { commitTranslationAttempt, translationAttemptMessage } from '../src/lib/translation-attempt.ts';
import { createKeyedOperationQueue } from '../src/lib/keyed-operation-queue.ts';

test('partial AI results persist successes and failures without dropping existing text', () => {
  const project = createEnglishChineseCaptionTrack(exportProject({ captions: [
    { id: 'c1', text: 'Hello', startMs: 0, endMs: 1000, wordIds: [] },
    { id: 'c2', text: 'Goodbye', startMs: 1000, endMs: 2000, wordIds: [] },
  ] }));
  const track = project.captionTracks.translations[0];
  const writes = automaticTranslationCueWrites({ captions: project.captions,
    translatedById: new Map([['c1', '\u4f60\u597d'], ['c2', 'Goodbye']]), previousById: new Map(), targetLanguage: 'zh-Hans' });
  const next = commitTranslationAttempt(project, track.id, project.captions, writes);
  assert.deepEqual(next.captionTracks.translations[0].cues.map(c => c.status), ['translated', 'failed']);
  assert.equal(next.captionTracks.translations[0].cues[0].text, '\u4f60\u597d');
  assert.equal(track.cues[0].text, '');
  assert.match(translationAttemptMessage(next, track.id, ['c1', 'c2']), /1 subtitles could not/);
  assert.throws(() => buildTimelineRenderPlan(next), /need translation/);
  const retry = commitTranslationAttempt(next, track.id, [project.captions[1]], [
    { sourceCaptionId: 'c2', translatedText: '\u518d\u89c1', translationStatus: 'translated' },
  ]);
  assert.equal(translationAttemptMessage(retry, track.id, ['c2']), undefined);
  assert.equal(buildTimelineRenderPlan(retry).captions.length, 4);
  const failedAgain = commitTranslationAttempt(retry, track.id, [project.captions[1]], []);
  assert.equal(failedAgain.captionTracks.translations[0].cues[1].text, '\u518d\u89c1');
  assert.equal(failedAgain.captionTracks.translations[0].cues[1].status, 'failed');
});

test('disabled caption rendering and off-timeline incomplete translations do not block video', () => {
  const project = createEnglishChineseCaptionTrack(exportProject({ captions: [
    { id: 'c1', text: 'Hello', startMs: 0, endMs: 1000, wordIds: [] },
  ] }));
  assert.equal(buildTimelineRenderPlan({ ...project, export: { ...project.export, burnCaptions: false } }).captions.length, 0);
  assert.equal(buildTimelineRenderPlan({ ...project, layers: project.layers.map(l => ({ ...l, visible: false })) }).captions.length, 0);
  const outside = structuredClone(project);
  outside.captionTracks.translations[0].cues[0].startMs = 5000;
  outside.captionTracks.translations[0].cues[0].endMs = 6000;
  assert.equal(buildTimelineRenderPlan(outside).captions.length, 1);
  assert.doesNotThrow(() => serializeSrt(outside));
  assert.doesNotThrow(() => serializeAss(outside));
});

test('independent translated captions export even when their primary caption is hidden', () => {
  const project = createEnglishChineseCaptionTrack(exportProject({ captions: [
    { id: 'c1', text: 'Hello', startMs: 0, endMs: 1000, wordIds: [] },
  ] }), { c1: '\u4f60\u597d' });
  project.captions[0].timelineVisible = false;
  project.captionTracks.translations[0].cues[0].timelineVisible = true;
  assert.match(serializeSrt(project), /\u4f60\u597d/);
  assert.match(serializeAss(project), /\u4f60\u597d/);
  assert.doesNotMatch(serializeSrt(project), /Hello/);
  assert.equal(buildTimelineRenderPlan(project).captions.length, 1);
});

test('journal operations serialize write then clear and continue after failures', async () => {
  const queue = createKeyedOperationQueue();
  const gate = deferred();
  const events = [];
  const first = queue('draft', async () => { await gate.promise; events.push('write'); });
  const second = queue('draft', async () => { events.push('clear'); });
  await queue('other', async () => { events.push('other'); });
  assert.deepEqual(events, ['other']);
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['other', 'write', 'clear']);
  await assert.rejects(queue('draft', async () => { throw Error('storage failure'); }));
  assert.equal(await queue('draft', async () => 'retry'), 'retry');
});
