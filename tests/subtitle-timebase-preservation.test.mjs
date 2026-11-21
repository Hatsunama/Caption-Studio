// Additional preservation checks added AFTER the production edit.
import assert from 'node:assert/strict';
import test from 'node:test';
import {project,dual} from './fixtures/subtitle-timebase-cases.mjs';
import {serializeAss,serializeSrt} from '../src/lib/subtitle-export.ts';
import {setClipPlaybackRate,totalClipDuration} from '../src/lib/video-timeline.ts';
test('post-edit: NUL-only SRT primary cannot consume a real cue unit',()=>{
 const p=project([[0,0.1,'\0'],[0.1,3,'real']]);
 assert.equal(serializeSrt(p),'1\n00:00:00,000 --> 00:00:00,003\nreal\n');
 assert.equal(serializeAss(project([[0,1,'\0'],[1,30,'real']])).split('\n').filter(l=>l.startsWith('Dialogue:')).length,2);
});
test('post-edit: NUL-only primary with a target still emits its combined SRT cue',()=>{
 const p=dual(project([[0,0.1,'\0'],[0.1,3,'real']]));
 assert.equal(serializeSrt(p),'1\n00:00:00,000 --> 00:00:00,001\n译 x0\n\n2\n00:00:00,001 --> 00:00:00,003\nreal\n译 x1\n');
});
test('post-edit: accepted legacy 3999.8..4000.4 tail omission remains unchanged for both tracks',()=>{
 const p=dual(project([[3999.8,4000.4,'Primary']],4000));
 const before=structuredClone(p);
 assert.equal(serializeSrt(p),'');
 assert.equal(serializeAss(p).split('\n').filter(l=>l.startsWith('Dialogue:')).length,0);
 assert.deepEqual(p,before);
});
test('post-edit: speed-derived footage duration is floored per format with dual lines intact',()=>{
 let p=dual(project([[3000,4000,'Primary']],4000));
 p=setClipPlaybackRate(p,'original',1.5);
 const before=structuredClone(p);
 assert.equal(totalClipDuration(p.clips),4000/1.5);
 assert.equal(serializeSrt(p),'1\n00:00:02,000 --> 00:00:02,666\nPrimary\n译 x0\n');
 assert.deepEqual(serializeAss(p).split('\n').filter(l=>l.startsWith('Dialogue:')).map(l=>l.split(',').slice(1,3)),[['0:00:02.00','0:00:02.66'],['0:00:02.00','0:00:02.66']]);
 assert.deepEqual(p,before);
});

