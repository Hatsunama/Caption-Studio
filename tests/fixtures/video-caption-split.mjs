import assert from 'node:assert/strict';


import { splitVideoClip, reorderVideoClip, setCaptionTexts } from '../../src/lib/project-editor.ts';
import { anchorCaptionsToClips, mapSourceWordsToTimeline, buildClipTimeline } from '../../src/lib/video-timeline.ts';
import { serializeSrt, serializeAss } from '../../src/lib/subtitle-export.ts';
import { DEFAULT_CAPTION_STYLE, DEFAULT_VIDEO_TRANSFORM } from '../../src/types/project.ts';

// Bounds reconstructed from supplied device SRT proof and cuts.
// Word subdivisions are synthetic deterministic ASR support, not device ASR.
const cueData = [
  [230, 1690, 'First we introduce the scene and'],
  [1690, 3230, 'leave room for captions.'],
  [4000, 5610, 'Next we cut to the second view'],
  [5610, 6870, 'and listen to the sound.'],
  [7560, 9740, 'short sentences help us test the'],
  [9740, 10650, 'shared'],
  [11370, 12000, 'editor should'],
];
const crossingStyle = { textColor: '#123456', italic: true };
const visible = p => p.captions.filter(c => c.timelineVisible !== false);
const tokens = text => text.trim().split(/\s+/);
const range = c => [c.startMs, c.endMs];

function fixture(mode = 'automatic') {
  const clip = {
    id: 'original', sourceId: 'source', availableSourceStartMs: 0, availableSourceEndMs: 12000,
    sourceStartMs: 0, sourceEndMs: 12000, playbackRate: 1, gapBeforeMs: 0, gapAfterMs: 0,
    volume: 1, muted: false, fadeInMs: 0, fadeOutMs: 0,
    transitionAfter: { type: 'none', durationMs: 0 }, transform: structuredClone(DEFAULT_VIDEO_TRANSFORM),
  };
  const sourceWords = cueData.flatMap(([start, end, text], cueIndex) => {
    const parts = tokens(text);
    return parts.map((text, index) => ({
      id: 'w'+(cueIndex+1)+'-'+(index+1), text,
      startMs: Math.round(start + (end-start)*index/parts.length),
      endMs: Math.round(start + (end-start)*(index+1)/parts.length),
    }));
  });
  const words = mapSourceWordsToTimeline([clip], { source: sourceWords });
  let p = {
    schemaVersion: 2, id: 'split-regression', name: 'Split regression',
    createdAt: '2026-11-20T00:00:00.000Z', updatedAt: '2026-11-20T00:00:00.000Z',
    lifecycle: { status: 'saved' },
    sources: [{ id: 'source', uri: 'file:///synthetic.mp4', storageMode: 'copied',
      displayName: 'synthetic.mp4', durationMs: 12000, width: 1920, height: 1080, rotation: 0 }],
    clips: [clip], audioSources: [], audioClips: [],
    captions: cueData.map(([startMs, endMs, text], i) => ({
      id: 'c'+(i+1), startMs, endMs, text, textMode: 'automatic',
      wordIds: words.filter(w => w.startMs >= startMs && w.endMs <= endMs).map(w => w.id),
      ...(i === 1 ? { styleOverride: crossingStyle } : {}),
    })),
    transcription: { language: 'en', modelId: 'fixture-asr', wordTiming: 'source', words,
      sourceResults: { source: { language: 'en', modelId: 'fixture-asr',
        generatedAt: '2026-11-20T00:00:00.000Z', words: sourceWords } } },
    captionTracks: { schemaVersion: 1, primaryTrackId: 'captions', translations: [] },
    projectStyle: { ...structuredClone(DEFAULT_CAPTION_STYLE), animation: { id: 'none', intensity: 0, durationMs: 1 } },
    layers: [{ id: 'captions', kind: 'captions', name: 'Captions', visible: true }],
    canvas: { preset: '16:9', aspectWidth: 16, aspectHeight: 9, backgroundColor: '#000000' },
    videoTransform: structuredClone(DEFAULT_VIDEO_TRANSFORM),
    backgroundReplacement: { enabled: false },
    export: { resolution: '1080p', format: 'mp4', burnCaptions: true },
  };
  p.captions = anchorCaptionsToClips(p.captions, p.clips, words);
  if (mode === 'manual') p = setCaptionTexts(p, { c2: 'Edited words remain mine.' });
  if (mode === 'timeline') p.captions = p.captions.map(c => c.id === 'c2'
    ? { ...c, timingMode: 'timeline', sourceAnchor: undefined } : c);
  return p;
}

function execute(cut, mode) {
  const original = fixture(mode);
  const snapshot = structuredClone(original);
  const split = splitVideoClip(original, 'original', cut, 'left', 'right');
  assert.ok(split, 'real production split accepted fixture');
  const reordered = reorderVideoClip(split.project, split.rightClipId, 0);
  assert.ok(reordered, 'real production reorder accepted right to first');
  assert.deepEqual(original, snapshot, 'operations must not mutate input');
  assert.deepEqual(reordered.project.clips.map(c => c.id), ['right', 'left']);
  return { original, split: split.project, after: reordered.project };
}

function assertNoOverlap(cues) {
  const sorted = [...cues].sort((a,b) => a.startMs-b.startMs || a.endMs-b.endMs);
  assert.ok(sorted.length >= 7, 'primary text must not be removed to silence overlap');
  for (let i=0; i<sorted.length; i++) {
    const c=sorted[i];
    assert.ok(c.startMs>=0 && c.endMs<=12000 && c.endMs>c.startMs, JSON.stringify(c));
    if(i) assert.ok(sorted[i-1].endMs<=c.startMs,
      'primary overlap: '+JSON.stringify(sorted[i-1])+' vs '+JSON.stringify(c));
  }
}

function assertTextRetained(original, cues) {
  const actual=tokens(cues.map(c=>c.text).join(' '));
  const wanted=tokens(original.captions.map(c=>c.text).join(' '));
  for(const word of new Set(wanted)) {
    assert.ok(actual.filter(w=>w===word).length >= wanted.filter(w=>w===word).length,
      'lost text token '+JSON.stringify(word));
  }
}

function assertWordReferences(p, checkOwner = false) {
  const ids=new Set(p.transcription.words.map(w=>w.id));
  for(const c of visible(p).filter(c=>c.textMode==='automatic')) {
    assert.ok(c.wordIds.length, 'generated '+c.id+' lost all word references');
    for(const id of [...c.wordIds,...(c.sourceAnchor?.wordIds??[])]) {
      assert.ok(ids.has(id), c.id+': '+id+' missing from current transcription.words');
    }
    if (!checkOwner) continue;
    // Existence alone misses split's stale original-prefix words.
    const owner=p.clips.find(clip=>clip.id===c.sourceAnchor?.clipId);
    assert.ok(owner,c.id+' lost source owner');
    assert.ok(c.wordIds.every(id=>id.startsWith(owner.id+'-')),
      c.id+' word IDs retain replaced clip identity: '+c.wordIds.join(','));
  }
}

function srtCues(text) {
  return text.trim().split(/\r?\n\r?\n/).filter(Boolean).map(block=>{
    const [,timing,...body]=block.split(/\r?\n/);
    const time=s=>{const [h,m,sec,ms]=s.split(/[:,]/).map(Number);return h*3600000+m*60000+sec*1000+ms;};
    const [start,end]=timing.split(' --> ');
    return {startMs:time(start),endMs:time(end),text:body.join(' ')};
  });
}

function assCues(text) {
  return text.split(/\r?\n/).filter(line=>line.startsWith('Dialogue: 0,')).map(line=>{
    const fields=line.slice('Dialogue: '.length).split(',');
    const time=s=>{const [h,m,sec]=s.split(':').map(Number);return Math.round((h*3600+m*60+sec)*1000);};
    const rawText=fields.slice(9).join(',');
    return {startMs:time(fields[1]),endMs:time(fields[2]),rawText,
      text:rawText.replace(/\{[^}]*\}/g,'').replace(/\\N/g,' ').trim()};
  });
}


export { fixture, crossingStyle, visible, range, execute, assertNoOverlap, assertWordReferences, assertTextRetained, srtCues, assCues };
