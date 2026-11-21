import assert from 'node:assert/strict';
import test from 'node:test';
import {fixture} from './fixtures/video-caption-split.mjs';
import {splitVideoClip,reorderVideoClip} from '../src/lib/project-editor.ts';
import {setClipPlaybackRate} from '../src/lib/video-timeline.ts';
import {serializeAss,serializeSrt} from '../src/lib/subtitle-export.ts';
import {serializeProjectSnapshot} from '../src/lib/project-schema.ts';
function ranges(text,format){
 const time=s=>{const [h,m,sec]=s.replace(',','.').split(':').map(Number);return Math.round((h*3600+m*60+sec)*1000);};
 if(format==='ass')return text.split(/\r?\n/).filter(l=>l.startsWith('Dialogue: 0,')).map(l=>{const a=l.split(',');return [time(a[1]),time(a[2])];});
 return text.split(/\r?\n/).filter(l=>l.includes(' --> ')).map(l=>l.split(' --> ').map(time));
}
for(const [format,rate] of [['ass',1],['srt',4]])test(format+' keeps nonoverlapping source cuts nonoverlapping at its timestamp resolution',()=>{
 let p=fixture();p.captions[2].styleOverride={textColor:'#123456'};
 if(rate!==1)p=setClipPlaybackRate(p,'original',rate);
 const split=splitVideoClip(p,'original',5609/rate,'left','right');assert.ok(split);
 const edited=reorderVideoClip(split.project,'right',0).project;
 serializeProjectSnapshot(edited);
 const visible=edited.captions.filter(c=>c.timelineVisible!==false).sort((a,b)=>a.startMs-b.startMs);
 for(let i=1;i<visible.length;i++)assert.ok(visible[i-1].endMs<=visible[i].startMs,'source must be nonoverlapping before format conversion');
 const events=ranges(format==='ass'?serializeAss(edited):serializeSrt(edited),format);
 assert.equal(events.length,visible.length,'no text dropped');
 for(let i=0;i<events.length;i++){assert.ok(events[i][1]>events[i][0]);if(i)assert.ok(events[i-1][1]<=events[i][0],JSON.stringify(events));}
});
