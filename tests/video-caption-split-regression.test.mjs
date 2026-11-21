import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { buildClipTimeline } from '../src/lib/video-timeline.ts';
import { serializeSrt, serializeAss } from '../src/lib/subtitle-export.ts';
import { fixture, crossingStyle, visible, range, execute, assertNoOverlap, assertWordReferences, assertTextRetained, srtCues, assCues } from './fixtures/video-caption-split.mjs';
for(const [device,cut] of [['Sam',2784],['Seeker',1749]]) {
  for(const mode of ['automatic','manual']) {
    const label=device+'/'+mode;
    test(label+': crossing primary cue keeps source coverage and text/style',()=>{
      const {original,after}=execute(cut,mode);
      const fragments=visible(after).filter(c=>c.styleOverride?.textColor===crossingStyle.textColor);
      assert.ok(fragments.length,'crossing cue disappeared');
      const sourceRanges=fragments.map(c=>{
        assert.equal(c.timingMode,'source',c.id+': crossing cue was detached from footage');
        const owner=buildClipTimeline(after.clips).find(e=>e.clip.id===c.sourceAnchor?.clipId);
        assert.ok(owner,c.id+': missing surviving owner');
        assert.ok(c.startMs>=owner.startMs && c.endMs<=owner.endMs,'fragment crosses unrelated footage');
        assert.deepEqual(range(c), [
          owner.startMs + c.sourceAnchor.sourceStartMs - owner.clip.sourceStartMs,
          owner.startMs + c.sourceAnchor.sourceEndMs - owner.clip.sourceStartMs,
        ], 'fragment timing must follow its actual source intersection');
        assert.deepEqual(c.styleOverride,crossingStyle);
        if(mode==='manual') assert.equal(c.textMode,'manual','manual edit became generated');
        return [c.sourceAnchor.sourceStartMs,c.sourceAnchor.sourceEndMs];
      }).sort((a,b)=>a[0]-b[0]);
      assert.deepEqual(sourceRanges,[[1690,cut],[cut,3230]],'both source intersections survive independently');
      assertTextRetained(original,visible(after));
      if(mode==='manual') {
        const text=fragments.map(c=>c.text).join(' ');
        assert.ok(!text.includes('leave')&&!text.includes('captions.'),'ASR replaced the manual edit');
      }
      assert.equal(new Set(after.captions.map(c=>c.id)).size,after.captions.length,'unique fragment IDs');
    });

    test(label+': resulting primary timeline has no overlaps or text loss',()=>{
      const {original,after}=execute(cut,mode);
      assertTextRetained(original,visible(after));
      assertNoOverlap(visible(after));
    });

    for(const format of ['srt','ass']) {
      test(label+': actual '+format.toUpperCase()+' primary events retain text/style without overlap',()=>{
        const {original,after}=execute(cut,mode);
        const serialized=format==='srt'?serializeSrt(after):serializeAss(after);
        const cues=format==='srt'?srtCues(serialized):assCues(serialized);
        assertTextRetained(original,cues);
        if(format==='ass') {
          const styled=cues.filter(c=>c.text.includes(mode==='manual'?'Edited':'leave'));
          assert.ok(styled.length);
          for(const cue of styled) {
            assert.match(cue.rawText,/\\c&H00563412&/,'actual cue color exported');
            assert.match(cue.rawText,/\\i1/,'actual cue italic exported');
          }
        }
        assertNoOverlap(cues);
      });
    }
  }

  for(const stage of ['split','after']) {
    test(device+': generated word references resolve to current '+stage+' words',()=>{
      assertWordReferences(execute(cut,'automatic')[stage]);
    });
    test(device+': generated word references match current '+stage+' clip ownership',()=>{
      assertWordReferences(execute(cut,'automatic')[stage], true);
    });
  }

  test(device+': intentionally timeline-owned caption remains independent',()=>{
    const {original,split,after}=execute(cut,'timeline');
    const before=original.captions.find(c=>c.id==='c2');
    for(const p of [split,after]) {
      const c=p.captions.find(c=>c.id==='c2');
      assert.equal(c.timingMode,'timeline');
      assert.equal(c.sourceAnchor,undefined);
      assert.deepEqual(range(c),range(before));
      assert.equal(c.text,before.text);
      assert.deepEqual(c.styleOverride,before.styleOverride);
    }
  });
}

test('control: unsplit fixture has valid source owners and generated word references',()=>{
  const p=fixture();
  assertWordReferences(p,true);
  assertNoOverlap(visible(p));
});
for(const format of ['srt','ass']) {
  test('control: unsplit actual '+format.toUpperCase()+' retains text without overlap',()=>{
    const p=fixture();
    const cues=format==='srt'?srtCues(serializeSrt(p)):assCues(serializeAss(p));
    assertTextRetained(p,cues);
    assertNoOverlap(cues);
  });
}

if(process.env.CAPTION_REGRESSION_EVIDENCE==='1') {
  mkdirSync(new URL('./results/',import.meta.url),{recursive:true});
  for(const [device,cut] of [['sam',2784],['seeker',1749]]) {
    const result=execute(cut,'automatic');
    writeFileSync(new URL('./results/'+device+'.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
    writeFileSync(new URL('./results/'+device+'.srt',import.meta.url),serializeSrt(result.after));
    writeFileSync(new URL('./results/'+device+'.ass',import.meta.url),serializeAss(result.after));
  }
}
