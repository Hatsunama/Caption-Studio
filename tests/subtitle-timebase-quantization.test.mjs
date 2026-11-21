import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {project,dual,representativeProjects} from './fixtures/subtitle-timebase-cases.mjs';
import {serializeSrt,serializeAss} from '../src/lib/subtitle-export.ts';
const serializers={srt:serializeSrt,ass:serializeAss};
const quantum={srt:1,ass:10};
function events(p,format) {
 const value=serializers[format](p);
 const time=s=>{const [h,m,sec]=s.replace(',','.').split(':').map(Number);return Math.round((h*3600+m*60+sec)*1000);};
 if(format==='ass') return value.split('\n').filter(l=>l.startsWith('Dialogue:')).map(l=>{
   const fields=l.split(',');return {start:time(fields[1]),end:time(fields[2]),body:fields.slice(9).join(','),layer:Number(fields[0].slice(10))};
 });
 return value.trimEnd().split('\n\n').filter(Boolean).map(b=>{
   const [,timing,...body]=b.split('\n');const [start,end]=timing.split(' --> ').map(time);return {start,end,body:body.join('\n')};
 });
}
function ordered(es) {
 for(let i=0;i<es.length;i++) { assert.ok(es[i].end>es[i].start,JSON.stringify(es));if(i)assert.ok(es[i-1].end<=es[i].start,JSON.stringify(es)); }
}
for(const format of ['srt','ass']) {
 const q=quantum[format];
 test(`${format}: tiny shared boundaries preserve every event and payload`,()=>{
   const p=project([[0,q/10,'first  authored\nline'],[q/10,2*q,'second'],[2*q,4*q,'third']]);
   const before=structuredClone(p);const es=events(p,format);
   assert.equal(es.length,3);ordered(es);
   assert.deepEqual(es.map(e=>[e.start,e.end]),[[0,q],[q,2*q],[2*q,4*q]]);
   assert.deepEqual(p,before);
   if(format==='srt') assert.deepEqual(es.map(e=>e.body),['first  authored\nline','second','third']);
   else { assert.ok(es[0].body.endsWith('first  authored\\Nline'));for(const e of es){assert.ok(e.body.includes('\\i1'));assert.ok(e.body.includes('\\c&H00563412&'));} }
 });
 test(`${format}: retained positive end tail and predecessor fit footage without padding`,()=>{
   // Post-edit fixture correction: the initial two-event prefix itself exceeded the drift bound.
   const p=project([[0,8.9*q],[8.9*q,9.1*q],[9.1*q,9.49*q,'retained tail']],10*q);
   const before=structuredClone(p);const es=events(p,format);assert.equal(es.length,3);ordered(es);
   assert.deepEqual(es.map(e=>[e.start,e.end]),[[0,8*q],[8*q,9*q],[9*q,10*q]]);
   assert.deepEqual(p,before);
 });
 test(`${format}: inherited, independent and orphan target events share one timebase`,()=>{
   const p=dual(project([[0,0.1*q,'primary'],[100*q,120*q,'hidden']]));
   p.captions[1].timelineVisible=false;
   const cues=p.captionTracks.translations[0].cues;
   Object.assign(cues[0],{text:'independent',startMs:0.1*q,endMs:3*q});
   Object.assign(cues[1],{text:'orphan',startMs:3*q,endMs:4*q,timelineVisible:true});
   const es=events(p,format).sort((a,b)=>a.start-b.start||a.end-b.end);
   assert.equal(es.length,3);ordered(es);
   assert.deepEqual(es.map(e=>[e.start,e.end]),[[0,q],[q,3*q],[3*q,4*q]]);
   // Independent target remains independently authored, rather than aligned to primary.
   const aligned=dual(project([[0,0.1*q,'primary'],[0.1*q,3*q,'next']]));
   const ae=events(aligned,format);
   assert.equal(ae.length,format==='srt'?2:4);
   if(format==='srt'){ordered(ae);assert.equal(ae[0].body,'primary\n译 x0');assert.equal(ae[1].body,'next\n译 x1');}
   else assert.deepEqual(ae.map(e=>[e.start,e.end]),[[0,q],[0,q],[q,3*q],[q,3*q]]);
 });
 test(`${format}: overlapping interleaved ranges are not flattened`,()=>{
   const p=project([[3*q,7*q],[0,q/10],[q/10,5*q],[8*q,9*q]]);
   const es=events(p,format);assert.equal(es.length,4);
   assert.deepEqual(es.map(e=>[e.start,e.end]),[[0,q],[q,5*q],[3*q,7*q],[8*q,9*q]]);
   assert.ok(es[1].end>es[2].start);
 });
 test(`${format}: infeasible fractional chain throws an actionable error without mutation`,()=>{
   const p=project([[0,q/10],[q/10,q/5],[q/5,3*q/10],[3*q/10,4*q/10]]);
   const before=structuredClone(p);
   assert.throws(()=>serializers[format](p),format==='ass'?/ASS.*(SRT|timing)/i:/SRT.*timing/i);
   assert.deepEqual(p,before);
 });
 test(`${format}: legacy omissions and invalid/blank events do not constrain timebase`,()=>{
   const p=project([[0,20],[3999.8,4000.4],[100,100],[-20,-10],[4100,4200],[10,10.01,'   ']],4000);
   assert.equal(events(p,format).length,1);
   assert.equal(events(p,format)[0].end,20);
 });
}
test('representative legacy exports remain byte identical, including styles, whitespace, dual lines, unsorted ranges and gaps',()=>{
 const baselines=JSON.parse(readFileSync(new URL('./fixtures/subtitle-timebase-baselines.json',import.meta.url),'utf8'));
 representativeProjects().forEach((p,i)=>{assert.equal(serializeSrt(p),baselines[i].srt);assert.equal(serializeAss(p),baselines[i].ass);});
});

