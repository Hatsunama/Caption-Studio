import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, assertWordReferences, assertTextRetained, visible } from './fixtures/video-caption-split.mjs';
import { splitVideoClip, reorderVideoClip, trimVideoClip, deleteVideoClip } from '../src/lib/project-editor.ts';
import { buildClipTimeline, mapSourceWordsToTimeline, completeVideoTimelineEdit } from '../src/lib/video-timeline.ts';
import { mergeProjectCaptionPair } from '../src/lib/caption-merge.ts';
import { serializeProjectSnapshot, decodeVersionTwoProject } from '../src/lib/project-schema.ts';
import { createTranslationCaptionTrack } from '../src/lib/caption-tracks.ts';

function ownership(p) {
  const entries=buildClipTimeline(p.clips);
  const words=new Map(p.transcription.words.map(w=>[w.id,w]));
  assert.equal(new Set(p.captions.map(c=>c.id)).size,p.captions.length);
  for(const c of visible(p).filter(c=>c.sourceAnchor)) {
    const owner=entries.find(e=>e.clip.id===c.sourceAnchor.clipId);
    assert.ok(owner);
    assert.ok(c.startMs>=owner.startMs && c.endMs<=owner.endMs && c.endMs>c.startMs);
    assert.deepEqual(c.wordIds,c.sourceAnchor.wordIds);
    for(const id of c.wordIds) {
      assert.ok(id.startsWith(owner.clip.id+'-') && words.has(id));
      assert.ok(words.get(id).startMs<c.endMs && words.get(id).endMs>c.startMs);
    }
  }
}
const crossing=p=>p.captions.filter(c=>c.styleOverride?.textColor==='#123456');
for (const cut of [1690,1691,1749,2075,2784,3229,3230]) {
  test('boundary/support cut '+cut,()=>{
    const p=fixture(); const result=splitVideoClip(p,'original',cut,'left','right');
    ownership(result.project);
    const pieces=crossing(result.project);
    assert.deepEqual(pieces.map(c=>[c.sourceAnchor.sourceStartMs,c.sourceAnchor.sourceEndMs]),
      cut===1690 || cut===3230 ? [[1690,3230]] : [[1690,cut],[cut,3230]]);
    for(const piece of pieces) {
      const a=piece.sourceAnchor;
      const expected=p.transcription.sourceResults.source.words.filter(w=>w.startMs<a.sourceEndMs && w.endMs>a.sourceStartMs);
      assert.equal(piece.text,expected.map(w=>w.text).join(' '));
    }
    ownership(reorderVideoClip(result.project,'right',0).project);
  });
}
for(const mode of ['automatic','manual']) {
  test('repeated split/reorder '+mode,()=>{
    const original=fixture(mode);
    let p=splitVideoClip(original,'original',1749,'left','right').project;
    p=reorderVideoClip(p,'right',0).project;
    p=splitVideoClip(p,'right',1035,'part1','part2').project;
    p=reorderVideoClip(p,'part2',0).project;
    p=reorderVideoClip(p,'left',0).project;
    ownership(p); assertTextRetained(original,visible(p));
    assert.deepEqual(crossing(p).map(c=>[c.sourceAnchor.sourceStartMs,c.sourceAnchor.sourceEndMs]).sort((a,b)=>a[0]-b[0]),
      [[1690,1749],[1749,2784],[2784,3230]]);
    if(mode==='manual') for(const c of crossing(p)) { assert.equal(c.text,'Edited words remain mine.'); assert.equal(c.textMode,'manual'); }
  });
}
test('colliding clip and caption IDs allocate distinct conventional IDs',()=>{
  const p=fixture(); p.captions.push({...p.captions[1],id:'c2-original-3',timingMode:'timeline',sourceAnchor:undefined});
  const r=splitVideoClip(p,'original',2784,'original','original');
  assert.deepEqual(r.project.clips.map(c=>c.id),['original-2','original-3']);
  assert.deepEqual(crossing(r.project).filter(c=>c.sourceAnchor).map(c=>c.id),['c2','c2-original-3-2']);
  ownership(r.project);
});
for(const cache of ['missing','empty','none']) {
  test('manual text/style and no canonical truth: '+cache,()=>{
    const p=fixture('manual');
    const capturedSource=structuredClone(p.transcription.sourceResults.source.words);
    p.transcription.sourceResults=cache==='missing'?{}:{source:{...p.transcription.sourceResults.source,words:[]}};
    if(cache==='none') { p.transcription.words=[]; p.captions=p.captions.map(c=>({...c,wordIds:[],sourceAnchor:{...c.sourceAnchor,wordIds:[]}})); }
    const snapshot=structuredClone(p.transcription.sourceResults);
    let r=splitVideoClip(p,'original',1749,'left','right');
    let after=reorderVideoClip(r.project,'right',0).project;
    ownership(after);
    assert.deepEqual(after.transcription.sourceResults,snapshot);
    for(const c of crossing(after)) { assert.equal(c.text,'Edited words remain mine.'); assert.equal(c.textMode,'manual'); assert.deepEqual(c.styleOverride,p.captions[1].styleOverride); }
    if(cache!=='none') assert.deepEqual(after.transcription.words,mapSourceWordsToTimeline(after.clips,{source:capturedSource}));
  });
}
for(const mode of ['automatic','manual']) {
  test('trim/restore and delete after cut '+mode,()=>{
    const p=splitVideoClip(fixture(mode),'original',2784,'left','right').project;
    let trimmed=trimVideoClip(p,'right','start',3000).project; ownership(trimmed);
    const restored=trimVideoClip(trimmed,'right','start',2784).project; ownership(restored);
    assert.deepEqual(crossing(restored).map(c=>c.text),crossing(p).map(c=>c.text));
    for(const id of ['left','right']) {
      const deleted=deleteVideoClip(p,id).project; ownership(deleted);
      assert.ok(deleted.captions.every(c=>c.sourceAnchor?.clipId!==id));
      assert.ok(crossing(deleted).length);
    }
  });
}
test('canonical word metadata/style and exact clipped support survive cut/reorder',()=>{
  const p=fixture(); const source=p.transcription.sourceResults.source.words;
  source.find(w=>w.id==='w2-1').styleOverride={italic:true,textColor:'#abcdef'};
  p.transcription.words=mapSourceWordsToTimeline(p.clips,{source});
  const cut=1749; let after=splitVideoClip(p,'original',cut,'left','right').project;
  const pair=after.transcription.words.filter(w=>w.id.endsWith('-w2-1'));
  assert.equal(pair.length,2); assert.deepEqual(pair.map(w=>[w.startMs,w.endMs]),[[1690,cut],[cut,2075]]);
  for(const w of pair) assert.deepEqual(w.styleOverride,source.find(w=>w.id==='w2-1').styleOverride);
  after=reorderVideoClip(after,'right',0).project; ownership(after);
});
test('tiny same-style cut fragments remain source-owned with lossless provenance',()=>{
  const p=fixture(); delete p.captions[1].styleOverride;
  const result=splitVideoClip(p,'original',1691,'left','right');
  const after=reorderVideoClip(result.project,'right',0).project;
  ownership(after); assertTextRetained(p,visible(after));
  for(const project of [result.project,after,completeVideoTimelineEdit(after)]) {
    ownership(project);
    const history=project.captions.flatMap(c=>c.mergeProvenance?.fragments??[{captionId:c.id,primaryText:c.text}]);
    assert.ok(history.some(f=>f.captionId==='c2' && f.primaryText.includes('leave')));
  }
});
test('nonunit playback rate source intersections',()=>{
  const p=fixture(); p.clips[0].playbackRate=2;
  p.transcription.words=mapSourceWordsToTimeline(p.clips,{source:p.transcription.sourceResults.source.words});
  p.captions=p.captions.map(c=>({...c,startMs:c.startMs/2,endMs:c.endMs/2}));
  const r=splitVideoClip(p,'original',874.5,'left','right'); ownership(r.project);
  const after=reorderVideoClip(r.project,'right',0).project; ownership(after);
  for(const c of crossing(after)) {
    const e=buildClipTimeline(after.clips).find(e=>e.clip.id===c.sourceAnchor.clipId);
    assert.equal(c.startMs,e.startMs+(c.sourceAnchor.sourceStartMs-e.clip.sourceStartMs)/2);
  }
});
test('split reconciles saved independent translation metadata atomically',()=>{
  const p=createTranslationCaptionTrack(fixture(),{id:'es',languageTag:'es',displayName:'Spanish',translations:{c2:'Texto guardado'}});
  p.captionTracks.independentTimingOrigins={'es:c2':11};
  Object.assign(p.captionTracks.translations[0].cues.find(c=>c.sourceCaptionId==='c2'),
    {status:'reviewed',reviewed:true,styleOverride:{italic:true},startMs:1700,endMs:3200});
  const snapshot=structuredClone(p.captionTracks);
  const r=splitVideoClip(p,'original',1749,'left','right');
  const retained=r.project.captionTracks.translations[0].cues.find(c=>c.sourceCaptionId==='c2');
  assert.equal(retained.text,snapshot.translations[0].cues.find(c=>c.sourceCaptionId==='c2').text);
  assert.deepEqual([retained.startMs,retained.endMs],[1700,3200]);
  assert.equal(retained.status,'stale');
  const child=r.project.captionTracks.translations[0].cues.find(c=>c.sourceCaptionId==='c2-right');
  assert.ok(child);assert.equal(child.status,'pending');assert.equal(child.text,'');
  assert.ok(!('captionSplitLineage' in r.project));
});
test('real serialize/decode/reopen preserves fragments and words',()=>{
  const p=fixture('manual'); p.sources[0].storageMode='copied';
  const r=splitVideoClip(p,'original',1749,'left','right');
  const after=reorderVideoClip(r.project,'right',0).project;
  const reopened=decodeVersionTwoProject(JSON.parse(serializeProjectSnapshot(after))); ownership(reopened);
  for(const c of crossing(after)) {
    const restored=reopened.captions.find(x=>x.id===c.id);
    assert.deepEqual(restored.sourceAnchor,c.sourceAnchor); assert.equal(restored.text,c.text); assert.deepEqual(restored.styleOverride,c.styleOverride);
  }
  ownership(reorderVideoClip(reopened,'left',0).project);
});


test('split preserves tiny fragments even when same-owner absorption would be legal',()=>{
  const p=fixture(); p.sources[0].storageMode='copied';
  p.captions=p.captions.filter(c=>c.id==='c2'); delete p.captions[0].styleOverride;
  const c=p.captions[0];
  p.captions.push({...c,id:'neighbor',text:'Next',textMode:'manual',startMs:3230,endMs:3500,wordIds:[],sourceAnchor:{clipId:'original',sourceStartMs:3230,sourceEndMs:3500,wordIds:[]}});
  const r=splitVideoClip(p,'original',3229,'left','right');
  assert.deepEqual(r.project.captions.filter(c=>c.id==='c2'||c.id==='c2-right').map(c=>c.id),['c2','c2-right']);
  for(const project of [r.project,reorderVideoClip(r.project,'right',0).project]) {
    ownership(project);
    const tiny=project.captions.find(c=>c.id==='c2-right');
    assert.ok(tiny); assert.equal(tiny.endMs-tiny.startMs,1); assert.equal(tiny.text,'captions.');
    assert.ok(project.captions.find(c=>c.id==='neighbor')); serializeProjectSnapshot(project);
  }
  const regrouped=completeVideoTimelineEdit(r.project); ownership(regrouped);
  assert.ok(regrouped.captions.find(c=>c.id==='c2-right')?.mergeProvenance,'valid fixture actually exercises absorption');
  assertTextRetained(p,visible(regrouped));
  for(const merged of regrouped.captions.filter(c=>c.mergeProvenance)) {
    assert.equal(new Set(merged.mergeProvenance.fragments.map(f=>f.captionId)).size,merged.mergeProvenance.fragments.length);
    assert.ok(merged.mergeProvenance.fragments.every(f=>f.primary.sourceAnchor.clipId===merged.sourceAnchor.clipId));
  }
});
test('existing merge provenance survives a near-boundary source cut without mutation',()=>{
  const original=fixture('manual'); original.sources[0].storageMode='copied';
  const p=mergeProjectCaptionPair(original,'c1','c2'); assert.ok(p);
  const c=p.captions.find(c=>c.id==='c1');
  c.styleOverride={textColor:'#123456',italic:true};
  const snapshot=structuredClone(c.mergeProvenance);
  const r=splitVideoClip(p,'original',1691,'left','right');
  for(const piece of crossing(r.project)) assert.deepEqual(piece.mergeProvenance,snapshot);
  const after=reorderVideoClip(r.project,'right',0).project;
  ownership(after); serializeProjectSnapshot(after);
  for(const piece of crossing(after)) assert.deepEqual(piece.mergeProvenance,snapshot);
  assert.deepEqual(c.mergeProvenance,snapshot);
});
test('automatic source cues without any word support preserve literal text',()=>{
  const p=fixture(); p.transcription.sourceResults={}; p.transcription.words=[];
  p.captions=p.captions.map(c=>({...c,wordIds:[],sourceAnchor:{...c.sourceAnchor,wordIds:[]}}));
  const r=splitVideoClip(p,'original',1749,'left','right');
  const after=reorderVideoClip(r.project,'right',0).project; ownership(after);
  for(const piece of crossing(after)) assert.equal(piece.text,p.captions[1].text);
  assert.deepEqual(after.transcription.words,[]); assert.deepEqual(after.transcription.sourceResults,{});
});
test('automatic fragments persist with source word styles and can be cut again',()=>{
  const p=fixture(); p.sources[0].storageMode='copied';
  p.transcription.sourceResults.source.words.find(w=>w.id==='w2-1').styleOverride={italic:true};
  const r=splitVideoClip(p,'original',1749,'left','right');
  const reopened=decodeVersionTwoProject(JSON.parse(serializeProjectSnapshot(r.project)));
  ownership(reopened);
  assert.deepEqual(reopened.transcription.words.filter(w=>w.id.endsWith('-w2-1')).map(w=>w.styleOverride),[{italic:true},{italic:true}]);
  const again=splitVideoClip(reopened,'right',2784,'a','b'); ownership(again.project);
  assert.deepEqual(crossing(again.project).map(c=>c.id),['c2','c2-right','c2-right-b']);
  assert.ok(!('translationReconciliationPending' in again));
});
