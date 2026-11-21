import { fixture } from './video-caption-split.mjs';
import { createEnglishChineseCaptionTrack } from '../../src/lib/caption-tracks.ts';
export function project(ranges, duration = 12000) {
  const p = fixture();
  p.clips[0].sourceEndMs = duration;
  p.clips[0].availableSourceEndMs = duration;
  p.sources[0].durationMs = duration;
  p.captions = ranges.map(([startMs,endMs,text],i) => ({
    id: `x${i}`, startMs,endMs,text: text ?? `text ${i}`,wordIds:[],textMode:'manual',
    styleOverride:{textColor:'#123456',italic:true},
  }));
  return p;
}
export function dual(p) {
  return createEnglishChineseCaptionTrack(p, Object.fromEntries(p.captions.map(c=>[c.id,`译 ${c.id}`])));
}
export function representativeProjects() {
  const styled = fixture();
  styled.captions[0].text = '  Authored  spaces\r\nline {braces} \\ end  ';
  styled.captions[0].styleOverride = {textColor:'#abcdef',italic:true};
  styled.transcription.words[7].styleOverride = {textColor:'#ff0000'};
  const paired = dual(project([[100,500,'primary one'],[1000,1500,'primary two'],[2000,2500,'hidden primary']]));
  paired.captions[2].timelineVisible=false;
  const cues=paired.captionTracks.translations[0].cues;
  Object.assign(cues[1],{startMs:1100,endMs:1600});
  Object.assign(cues[2],{startMs:2200,endMs:2700,timelineVisible:true});
  return [fixture(),styled,paired,project([[300,700],[0,200],[100,500],[900,1100]])];
}
