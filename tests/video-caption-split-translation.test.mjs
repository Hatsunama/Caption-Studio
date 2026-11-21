import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './fixtures/video-caption-split.mjs';
import { splitVideoClip, reorderVideoClip } from '../src/lib/project-editor.ts';
import { createTranslationCaptionTrack, updatePairedCaptionTexts, setTranslationCueTiming } from '../src/lib/caption-tracks.ts';
import { serializeProjectSnapshot, decodeVersionTwoProject } from '../src/lib/project-schema.ts';

function translated(mode='automatic', independent=false) {
 let p=fixture(mode);
 p=createTranslationCaptionTrack(p,{id:'de',languageTag:'de',displayName:'German',translations:Object.fromEntries(p.captions.map(c=>[c.id,'Saved target '+c.id]))});
 p=updatePairedCaptionTexts(p,p.captions.map(c=>({trackId:'de',sourceCaptionId:c.id,translatedText:'Saved target '+c.id,translationStatus:'reviewed'})));
 p.captionTracks.translations[0].cues.find(c=>c.sourceCaptionId==='c2').styleOverride={textColor:'#FEDCBA'};
 if(independent) p=setTranslationCueTiming(p,'de','c2','move',1800,3100);
 return p;
}
const track=p=>p.captionTracks.translations[0];
const roundTrip=p=>decodeVersionTwoProject(JSON.parse(serializeProjectSnapshot(p)));
function split(p,cut){const r=splitVideoClip(p,'original',cut,'left','right');assert.ok(r);return r.project;}
for(const cut of [1749,2784]) {
 test(`${cut}: inherited target pieces exist immediately and stay inside their source pieces`,()=>{
  const p=translated(),s=split(p,cut);
  const pieces=s.captions.filter(c=>c.styleOverride?.textColor==='#123456');
  assert.equal(pieces.length,2);
  for(const source of pieces){
   const cue=track(s).cues.find(c=>c.sourceCaptionId===source.id);
   assert.ok(cue,'missing target record immediately after split');
   assert.equal(cue.text,'Saved target c2','retain saved target on both inherited pieces');
   assert.deepEqual([cue.startMs,cue.endMs],[source.startMs,source.endMs],'inherited target may not cross its video piece');
   assert.equal(cue.status,cue.sourceTextSnapshot===source.text?'reviewed':'stale');
   assert.deepEqual(cue.styleOverride,{textColor:'#FEDCBA'});
  }
  roundTrip(s);
 });
 test(`${cut}: independent target is retained once, new primary fragment is explicitly pending`,()=>{
  const p=translated('automatic',true),s=split(p,cut);
  assert.equal(track(s).cues.filter(c=>c.text==='Saved target c2').length,1,'do not duplicate independently timed target');
  const newPrimary=s.captions.find(c=>c.id!=='c2' && c.styleOverride?.textColor==='#123456');
  const child=track(s).cues.find(c=>c.sourceCaptionId===newPrimary.id);
  assert.ok(child,'new source piece must have a target record');
  assert.equal(child.text,'');assert.equal(child.status,'pending');assert.equal(child.reviewed,false);
  assert.equal(s.captionTracks.independentTimingOrigins[child.id],undefined,'no invented independent timing');
  roundTrip(s);
 });
 for(const mode of ['automatic','manual']) {
  test(`${cut}/${mode}: accepted targets and primary ownership survive split/reorder/save`,()=>{
   const original=translated(mode), before=structuredClone(original), s=split(original,cut);
   const r=reorderVideoClip(s,'right',0);assert.ok(r);const restored=roundTrip(r.project);
   assert.deepEqual(original,before);
   const sources=new Map(restored.captions.map(c=>[c.id,c]));
   assert.equal(track(restored).cues.length,sources.size);
   const ids=track(restored).cues.map(c=>c.id);assert.equal(new Set(ids).size,ids.length);
   for(const cue of track(original).cues)assert.ok(track(restored).cues.some(c=>c.text===cue.text),'accepted target lost: '+cue.sourceCaptionId);
   for(const cue of track(restored).cues){
    const source=sources.get(cue.sourceCaptionId);assert.ok(source);
    if(cue.status==='reviewed')assert.equal(cue.sourceTextSnapshot,source.text,'changed source falsely reviewed');
   }
   assert.deepEqual(track(restored).cues.find(c=>c.sourceCaptionId==='c2').styleOverride,{textColor:'#FEDCBA'});
   const crossing=restored.captions.filter(c=>c.styleOverride?.textColor==='#123456');
   assert.ok(crossing.length>=2,'crossing source cue was not fragmented');
   assert.ok(crossing.every(c=>c.timingMode==='source' && c.sourceAnchor));
  });
 }
 test(`${cut}: independently timed target survives split without invented word timing`,()=>{
  const p=translated('automatic',true), old=track(p).cues.find(c=>c.sourceCaptionId==='c2'), s=roundTrip(split(p,cut));
  const cue=track(s).cues.find(c=>c.sourceCaptionId==='c2');
  assert.equal(cue.text,'Saved target c2');assert.deepEqual([cue.startMs,cue.endMs],[old.startMs,old.endMs]);
  assert.equal(s.captionTracks.independentTimingOrigins[cue.id],0);
  assert.equal(cue.status,'stale');
  assert.equal(cue.sourceTextSnapshot,old.sourceTextSnapshot,'saved target keeps its original source snapshot');
 });
}
test('explicit timeline primary retains chosen timing',()=>{
 const p=translated('timeline',true),s=split(p,2784),r=reorderVideoClip(s,'right',0).project;
 const c=r.captions.find(c=>c.id==='c2');assert.equal(c.timingMode,'timeline');assert.deepEqual([c.startMs,c.endMs],[1690,3230]);
 assert.equal(track(r).cues.find(c=>c.sourceCaptionId==='c2').text,'Saved target c2');roundTrip(r);
});
test('independently timed child preserves explicit skip and visibility choices',()=>{
 const p=translated('automatic',true);
 Object.assign(track(p).cues.find(c=>c.sourceCaptionId==='c2'),{translationSkipped:true,timelineVisible:false});
 const s=split(p,2784), child=track(s).cues.find(c=>c.sourceCaptionId==='c2-right');
 assert.equal(child.text,'');assert.equal(child.status,'pending');
 assert.equal(child.translationSkipped,true);assert.equal(child.timelineVisible,false);
 roundTrip(s);
});
