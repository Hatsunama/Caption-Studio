import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import {runInNewContext} from 'node:vm';
import { timelineWidth, minimumTimelineScale, clampTimelineScale } from '../src/lib/timeline-scale.ts';
import {createTimelineBoundaryFeedback} from '../src/lib/timeline-boundary-feedback.ts';
import {timelineTouchIntent} from '../src/lib/timeline-touch-intent.ts';
const file=readFileSync(new URL('../src/components/editor/layer-timeline.tsx',import.meta.url),'utf8');
const declaration=file.slice(file.indexOf('function VideoMoveGrip('),file.indexOf('function TimelineRow('));
const ast=ts.createSourceFile('grip.tsx',declaration,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const fn=ast.statements.find(ts.isFunctionDeclaration);
const returned=fn.body.statements.filter(ts.isReturnStatement).at(-1);
const functionSource='export '+declaration.slice(0,returned.getStart(ast))+'return responder;\n}';
const output=ts.transpileModule(functionSource,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;

test('video gap conversion remains frozen across its own draft duration changes',()=>{
const slots=[];let cursor=0;
const slot=initial=>{const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return slots[i]};
const exported={};
runInNewContext(output,{exports:exported,useRef:value=>slot(()=>({current:value})),useState:initial=>[slot(initial),()=>{}],
 useCallback:fn=>fn,useContext:()=>undefined,useEffect(){},
 createTimelineBoundaryFeedback,timelineTouchIntent,timelineHaptic(){},
 TimelineGestureGeometryContext:{},PanResponder:{create:panHandlers=>({panHandlers})},
 clamp:(v,min,max)=>Math.min(max,Math.max(min,v)),REORDER_TILE:72,REORDER_GAP:8,setTimeout,clearTimeout});
const previews=[],commits=[],baseDuration=5000,viewport=278;
let props;
function render(gap=0){
 const duration=Math.max(baseDuration,baseDuration+gap);
 const scale=clampTimelineScale(32,minimumTimelineScale(duration,viewport));
 props={startMs:gap,endMs:gap+baseDuration,leadingGapMs:gap,clipIndex:0,clipCount:1,
 durationMs:duration,trackWidth:timelineWidth(duration,scale,viewport),
 selected:true,bodyLeft:0,bodyWidth:200,
 onPress(){},onGestureLock(){},onGestureCancel(){},onGapPreview:v=>previews.push(v),
 onGapCommit:v=>commits.push(v),onReorderPreview(){},onReorderCommit(){},onReorderCancel(){}};
 cursor=0;return exported.VideoMoveGrip(props).nativeCallbacks;
}
const callbacks=render(); callbacks.prepare(); callbacks.begin(20,0);
const first=previews.at(-1);render(first);
callbacks.move(20,0,1);
const second=previews.at(-1); render(second);
callbacks.move(20,0,1);callbacks.finish();
assert.equal(second,first);
assert.equal(previews[2],first);
assert.equal(commits[0],first);
});

