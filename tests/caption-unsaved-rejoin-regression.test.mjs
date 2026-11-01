import assert from 'node:assert/strict';
import test from 'node:test';
import { createCaptionProject } from '../src/lib/project-factory.ts';
import { createEnglishChineseCaptionTrack } from '../src/lib/caption-tracks.ts';
import { splitCaptionScriptBlock, mergeCaptionScriptBlock } from '../src/lib/caption-script.ts';
import { replaceVisibleCaptionScript } from '../src/lib/project-editor.ts';
import { serializeProjectSnapshot, decodeVersionTwoProject, decodeCaption } from '../src/lib/project-schema.ts';
for (const [name,text,cursor] of [['word-boundary','Return JSON',6],['midword','ReturnJSON',2],['two-spaces','Return  JSON',7],['line-break','Return\nJSON',7]]) test(`${name}: unsaved split -> rejoin -> Save must accept the resulting draft`,()=>{
  const p=createCaptionProject({id:'regression',name:'Disposable',sources:[{id:'source',uri:'file:///source.mp4',storageMode:'copied',displayName:'source.mp4',durationMs:4000,width:1080,height:1920,rotation:0}]});
  p.captions=[{id:'parent',text,startMs:0,endMs:2000,wordIds:[],textMode:'manual',timingMode:'timeline',timelineVisible:true}];
  assert.equal(replaceVisibleCaptionScript(p,p.captions).captions[0].text,text);
  const split=splitCaptionScriptBlock(p.captions,'parent',cursor,[],'fresh-child');
  const joined=mergeCaptionScriptBlock(split.captions,'fresh-child');
  assert.equal(joined.captions[0].text,text);
  const saved=replaceVisibleCaptionScript(p,joined.captions);
  const reloaded=decodeVersionTwoProject(JSON.parse(serializeProjectSnapshot(saved)));
  assert.equal(reloaded.captions.length,1);
  // Rejoining an unsaved split restores the exact original text.
  assert.equal(reloaded.captions[0].text,text);
});

function projectWith(text) {
  const project=createCaptionProject({id:'lineage',name:'Disposable',sources:[{id:'source',uri:'file:///source.mp4',storageMode:'copied',displayName:'source.mp4',durationMs:4000,width:1080,height:1920,rotation:0}]});
  project.captions=[{id:'parent',text,startMs:0,endMs:2000,wordIds:[],textMode:'manual',timingMode:'timeline',timelineVisible:true}];
  return project;
}

test('saved split round-trips its sibling seam and can rejoin after reopening',()=>{
  const original=projectWith('ReturnJSON');
  const split=splitCaptionScriptBlock(original.captions,'parent',2,[],'child');
  const saved=decodeVersionTwoProject(JSON.parse(serializeProjectSnapshot(replaceVisibleCaptionScript(original,split.captions))));
  assert.deepEqual(saved.captions.find(c=>c.id==='child').splitOrigin,{parentId:'parent',separator:''});
  const joined=mergeCaptionScriptBlock(saved.captions,'child');
  const reloaded=decodeVersionTwoProject(JSON.parse(serializeProjectSnapshot(replaceVisibleCaptionScript(saved,joined.captions))));
  assert.equal(reloaded.captions.length,1);
  assert.equal(reloaded.captions[0].text,'ReturnJSON');
});

test('two unsaved midword splits and joins save without phantom committed fragment identities',()=>{
  const original=projectWith('ReturnJSON');
  const first=splitCaptionScriptBlock(original.captions,'parent',2,[],'child-a');
  const second=splitCaptionScriptBlock(first.captions,'child-a',4,[],'child-b');
  const joinedRight=mergeCaptionScriptBlock(second.captions,'child-b');
  const joinedAll=mergeCaptionScriptBlock(joinedRight.captions,'child-a');
  const saved=decodeVersionTwoProject(JSON.parse(serializeProjectSnapshot(replaceVisibleCaptionScript(original,joinedAll.captions))));
  assert.equal(saved.captions.length,1);
  assert.equal(saved.captions[0].text,'ReturnJSON');
  assert.equal(saved.captions[0].mergeProvenance,undefined);
});

test('unknown draft join identity stays rejected and leaves the source project unchanged',()=>{
  const original=projectWith('Return JSON');
  const before=structuredClone(original);
  const split=splitCaptionScriptBlock(original.captions,'parent',6,[],'uncommitted');
  const joined=mergeCaptionScriptBlock(split.captions,'uncommitted');
  joined.captions[0].mergeProvenance.fragments[1].primary.splitOrigin=undefined;
  assert.throws(()=>replaceVisibleCaptionScript(original,joined.captions),/identities conflict/);
  assert.deepEqual(original,before);
});

test('unsaved split and rejoin retains the original independent translation',()=>{
  let original=projectWith('ReturnJSON');
  original.transcription.language='en';
  original=createEnglishChineseCaptionTrack(original,{parent:'返回 JSON'});
  const before=structuredClone(original.captionTracks);
  const split=splitCaptionScriptBlock(original.captions,'parent',2,[],'child');
  const joined=mergeCaptionScriptBlock(split.captions,'child');
  const saved=decodeVersionTwoProject(JSON.parse(serializeProjectSnapshot(replaceVisibleCaptionScript(original,joined.captions))));
  assert.deepEqual(JSON.parse(JSON.stringify(saved.captionTracks.translations[0].cues)),JSON.parse(JSON.stringify(before.translations[0].cues)));
});
test('rejoining a split of an archived cue retains only committed originals',()=>{
  const original=projectWith('ReturnJSON');
  original.captions.push({id:'other',text:'Later',startMs:2000,endMs:3000,wordIds:[],textMode:'manual',timingMode:'timeline',timelineVisible:true});
  const archived=decodeVersionTwoProject(JSON.parse(serializeProjectSnapshot(replaceVisibleCaptionScript(original,mergeCaptionScriptBlock(original.captions,'other').captions))));
  const prior=archived.captions[0].mergeProvenance.fragments.map(fragment=>fragment.captionId);
  const split=splitCaptionScriptBlock(archived.captions,'parent',2,[],'new-child');
  const rejoined=mergeCaptionScriptBlock(split.captions,'new-child');
  const saved=decodeVersionTwoProject(JSON.parse(serializeProjectSnapshot(replaceVisibleCaptionScript(archived,rejoined.captions))));
  assert.deepEqual(saved.captions[0].mergeProvenance.fragments.map(fragment=>fragment.captionId),prior);
  assert.equal(saved.captions[0].mergeProvenance.aliasesRetired,true);
});

test('a transient split child and a committed neighbor join in one draft without losing originals',()=>{
  const original=projectWith('ReturnJSON');
  original.captions.push({id:'other',text:'Later',startMs:2000,endMs:3000,wordIds:[],textMode:'manual',timingMode:'timeline',timelineVisible:true});
  const split=splitCaptionScriptBlock(original.captions,'parent',2,[],'new-child');
  const rightJoined=mergeCaptionScriptBlock(split.captions,'other');
  const allJoined=mergeCaptionScriptBlock(rightJoined.captions,'new-child');
  const saved=decodeVersionTwoProject(JSON.parse(serializeProjectSnapshot(replaceVisibleCaptionScript(original,allJoined.captions))));
  assert.equal(saved.captions.length,1);
  assert.equal(saved.captions[0].text,'ReturnJSON Later');
  assert.deepEqual(saved.captions[0].mergeProvenance.fragments.map(fragment=>fragment.captionId),['parent','other']);
});
test('split seam metadata cannot add arbitrary words during a later Join',()=>{
  const cue=projectWith('Return').captions[0];
  assert.throws(()=>decodeCaption({...cue,splitOrigin:{parentId:'left',separator:' injected '}},0),/split separator/);
});