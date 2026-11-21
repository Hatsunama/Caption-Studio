import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './fixtures/video-caption-split.mjs';
import { remapCaptionsToTimeline } from '../src/lib/video-timeline.ts';
import { splitVideoClip } from '../src/lib/project-editor.ts';

test('remapping many captions indexes word support once rather than scanning every word per cue',()=>{
 const p=fixture(),n=400,k=5;let reads=0;
 const clip={...p.clips[0],id:'clip',sourceEndMs:n*1000,availableSourceEndMs:n*1000};
 const words=Array.from({length:n*k},(_,i)=>({
  get id(){reads++;return 'clip-w'+i;},text:'word',
  get startMs(){reads++;return i*200;},get endMs(){reads++;return (i+1)*200;},
 }));
 const captions=Array.from({length:n},(_,i)=>({id:'c'+i,text:'word',textMode:'automatic',timingMode:'source',
  startMs:i*1000,endMs:(i+1)*1000,wordIds:[],
  sourceAnchor:{clipId:'clip',sourceStartMs:i*1000,sourceEndMs:(i+1)*1000,wordIds:[]}}));
 const result=remapCaptionsToTimeline(captions,[clip],words);
 for(let i=0;i<n;i++)assert.deepEqual(result[i].wordIds,Array.from({length:k},(_,j)=>'clip-w'+(i*k+j)));
 assert.ok(reads<100000,`word property reads grew with cues × words: ${reads}`);
});

test('manual script fragments preserve valid explicit word references without clip-prefixed IDs',()=>{
 const p=fixture(),c={...p.captions[0],text:'he',textMode:'manual',wordIds:['literal-word'],
  sourceAnchor:{...p.captions[0].sourceAnchor,wordIds:['literal-word']}};
 const words=[{id:'literal-word',text:'hello',startMs:c.startMs,endMs:c.endMs}];
 const result=remapCaptionsToTimeline([c],p.clips,words)[0];
 assert.equal(result.text,'he');assert.deepEqual(result.wordIds,['literal-word']);
 assert.deepEqual(result.sourceAnchor,c.sourceAnchor);
});

test('temporarily hidden source cues retain their durable anchor and can recover support',()=>{
 const p=fixture(),c=p.captions[1],clip={...p.clips[0],sourceEndMs:1000};
 const result=remapCaptionsToTimeline([c],[clip],p.transcription.words)[0];
 assert.equal(result.timelineVisible,false);assert.deepEqual(result.sourceAnchor,c.sourceAnchor);
});

test('minimal legacy callers without captionTracks can still split video safely',()=>{
 const p=fixture();delete p.captionTracks;
 const result=splitVideoClip(p,'original',2784,'left','right');
 assert.ok(result);assert.deepEqual(result.project.captionTracks.translations,[]);
 assert.ok(result.project.captions.every(c=>c.timingMode==='source'));
});

test('indexed support matches literal interval filtering for unsorted, overlapping and boundary words',()=>{
 const p=fixture(),clip={...p.clips[0],id:'clip',sourceEndMs:4000};
 const words=Array.from({length:250},(_,i)=>({id:(i%3?'clip-':'other-')+'w'+i,text:'word'+i,
  startMs:(i*137)%3500,endMs:(i*137)%3500+(i%7?80:1500)})).reverse();
 words.push({id:'clip-invalid',text:'invalid',startMs:NaN,endMs:3000});
 words.push({id:'clip-boundary',text:'boundary',startMs:1000,endMs:1200});
 const captions=Array.from({length:20},(_,i)=>({id:'c'+i,text:'original',textMode:'automatic',timingMode:'source',
  startMs:i*150,endMs:i*150+500,wordIds:[],sourceAnchor:{clipId:'clip',sourceStartMs:i*150,sourceEndMs:i*150+500,wordIds:[]}}));
 const actual=remapCaptionsToTimeline(captions,[clip],words);
 for(let i=0;i<captions.length;i++){
  const c=captions[i],expected=words.filter(w=>w.id.startsWith('clip-')&&w.startMs<c.endMs&&w.endMs>c.startMs);
  assert.deepEqual(actual[i].wordIds,expected.map(w=>w.id));
  assert.deepEqual(actual[i].sourceAnchor.wordIds,expected.map(w=>w.id));
 }
});
