// Actual package API/ref/platform execute; native queue, React hooks, colors and flags
// are explicit models. This is not native C++/JSI/Fabric or device proof.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
// Run directly with node --test or through the repository's tsx test runner.
if (!vm.SourceTextModule) {
  test('native API regression suite (VM modules child, 96 MB)', () => {
    const env={...process.env};delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, ['--max-old-space-size=96', '--experimental-vm-modules', '--test', '--test-reporter=tap', fileURLToPath(import.meta.url)], {env, encoding:'utf8'});
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(Number(r.stdout.match(/# tests (\d+)/)?.[1])>=24,'child executed actual API cases: '+r.stdout);
  });
} else {
const ts=require('typescript');
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const audit=process.env.REANIMATED_SOURCE_ROOT
  ? path.resolve(process.env.REANIMATED_SOURCE_ROOT)
  : path.join(repo,'node_modules/react-native-reanimated');
assert.equal(JSON.parse(fs.readFileSync(path.join(audit,'package.json'))).version,'4.5.1');
const runtimeFile = [path.join(repo,'node_modules/react-native-worklets/src/runtimeKind.ts'), path.join(audit,'queue-flush-audit/worklets-public/package/src/runtimeKind.ts')].find(p=>fs.existsSync(p));
assert.ok(runtimeFile,'Install locked Worklets or supply audited REANIMATED_SOURCE_ROOT');
const original=process.env.REANIMATED_TEST_ORIGINAL==='1';
const paths=['src/platformFunctions/setNativeProps.ts','lib/module/platformFunctions/setNativeProps.js','lib/module/platformFunctions/setNativeProps.js.map'];
const installed=Object.fromEntries(paths.map(p=>[p,fs.readFileSync(path.join(audit,p),'utf8')]));
const repair=require('../scripts/repair-reanimated-native-props.js');
const fullyRepaired=repair.repairPinned451({version:'4.5.1',files:installed});
// CI may already have run postinstall. Recover the canonical API inputs from
// those exact known bytes, using TypeScript's independent map generator for the
// reverse transformation. No external drive path or bundled replacement API.
const originals={...installed};
const addedFlush="  if (IS_ANDROID && !USE_ANIMATION_BACKEND) {\n    global._maybeFlushUIUpdatesQueue();\n  }\n";
originals[paths[0]]=originals[paths[0]].replace('  IS_ANDROID,\n','').replace("import { getStaticFeatureFlag } from '../featureFlags';\n\nconst USE_ANIMATION_BACKEND = getStaticFeatureFlag('USE_ANIMATION_BACKEND');\n\n",'').replace(addedFlush,'');
originals[paths[1]]=originals[paths[1]].replace('IS_ANDROID, ','').replace('import { getStaticFeatureFlag } from "../featureFlags/index.js";\n' + "const USE_ANIMATION_BACKEND = getStaticFeatureFlag('USE_ANIMATION_BACKEND');\n",'').replace(addedFlush,'');
const digest=s=>createHash('sha256').update(s).digest('hex');
if(digest(installed[paths[2]])==='7d47d97553c5431d1db6a05a5f3d719eb8c49c07dcd4be1ac7a26d3f6c439dd1') {
  const map=JSON.parse(installed[paths[2]]);
  const inverseLines=(before,after,normalize=x=>x)=>{
    const lines=after.split('\n'),inverse=new Map();let cursor=0;
    before.split('\n').forEach((line,index)=>{
      while(cursor<lines.length && normalize(lines[cursor])!==normalize(line))cursor++;
      assert.ok(cursor<lines.length);inverse.set(cursor++,index);
    });return inverse;
  };
  const source=inverseLines(originals[paths[0]],fullyRepaired[paths[0]]);
  const generated=inverseLines(originals[paths[1]],fullyRepaired[paths[1]],s=>s.replace('IS_ANDROID, ',''));
  const generator=ts.createSourceMapGenerator({getCurrentDirectory:()=>'.',getCanonicalFileName:s=>s},'',map.sourceRoot,'.',{});
  map.sources.forEach(s=>generator.addSource(s));map.names.forEach(s=>generator.addName(s));
  for(const s of ts.decodeMappings(map.mappings)) {
    const isImport=fullyRepaired[paths[1]].split('\n')[s.generatedLine]?.includes('import { IS_ANDROID,');
    if(isImport && s.generatedCharacter===9 && s.sourceLine===undefined)continue;
    generator.addMapping(generated.get(s.generatedLine),s.generatedCharacter-(isImport && s.generatedCharacter>=21 ? 12 : 0),s.sourceIndex,s.sourceLine===undefined ? undefined : source.get(s.sourceLine),s.sourceCharacter,s.nameIndex);
  }
  originals[paths[2]]=JSON.stringify({...map,mappings:generator.toJSON().mappings})+'\n';
}
assert.deepEqual(paths.map(p=>digest(originals[p])),[
  '715fd88324a37bdd528f85a4ee2dee34c37734968ee0f8705818445bc7f31fa0',
  '923e133e434c8b98ee3230d4d34da82b01d93795c870c903215be27dd820b5da',
  'd8d97211ba415acde6413194b0355d0f6075a56de967313051b5e89e303d6f0e',
]);
const repaired=original ? originals : fullyRepaired;
const clean=x=>JSON.parse(JSON.stringify(x));
// Only scheduled Reanimated frames drain pending operations. Ordinary Worklets
// frames do not; enqueue never mutates visible props. No native-event rescue.
class NativePendingQueue {
  pending=[]; visible=new Map([['old',274],['current',274]]);
  requests=0; drains=0; posted=false; events=[];
  constructor(mode){this.mode=mode;this.posted=mode==='running';}
  enqueue(ops){this.events.push('enqueue');this.pending.push(...clean(ops));}
  drain(){this.events.push('native-drain');this.drains++;for(const op of this.pending)this.visible.set(op.shadowNodeWrapper.tag,op.updates.transform?.[0]?.translateY);this.pending=[];}
  maybeFlush(){this.events.push('helper');this.requests++;
    if(this.posted)return; // NativeProxy delegates to existing running loop.
    if(this.mode==='draw'){this.events.push('non-layout-attempt');this.posted=true;return;}
    this.drain(); // idle/outside-draw native helper may deliver synchronously.
  }
  normalFrame(){this.events.push('normal-frame');if(this.posted){this.drain();this.posted=false;}}
}
async function fixture(entry,opts={}){
  const {os='android',backend=false,kind=2,jest=false,mode='draw'}=opts;
  const native=new NativePendingQueue(mode),warnings=[],calls=[];
  const ctx=vm.createContext({console,process:{env:jest?{NODE_ENV:'test'}:{}},__RUNTIME_KIND:kind});ctx.global=ctx;
  ctx._updateProps=ops=>{assert.equal(ops[0].updates.backgroundColor,0xff123456,'colors precede enqueue');native.enqueue(ops);};
  ctx._maybeFlushUIUpdatesQueue=()=>native.maybeFlush();
  const cache=new Map(),serializableMappingCache=new WeakMap();let refReads=0;
  function stub(id,exports){if(cache.has(id))return cache.get(id);const m=new vm.SyntheticModule(Object.keys(exports),function(){for(const[k,v]of Object.entries(exports))this.setExport(k,v);},{context:ctx,identifier:id});cache.set(id,m);return m;}
  async function load(file){file=path.resolve(file);if(cache.has(file))return cache.get(file);
    const relative=path.relative(audit,file).split(path.sep).join('/');
    const source=opts.fromDisk ? fs.readFileSync(file,'utf8') : (repaired[relative] ?? fs.readFileSync(file,'utf8'));
    const code=file.endsWith('.ts')?ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext},fileName:file}).outputText:source;
    const m=new vm.SourceTextModule(code,{context:ctx,identifier:file});cache.set(file,m);
    await m.link(async(id,ref)=>{
      if(id==='react-native')return stub(id,{Platform:{OS:os}});
      if(id==='react')return stub(id,{useRef:x=>({current:x}),useState:f=>[f(),()=>{}]});
      if(id==='react-native-worklets'){
        const runtime=await load(runtimeFile);
        return stub(id,{RuntimeKind:runtime.namespace.RuntimeKind,serializableMappingCache,createSerializable:x=>x});
      }
      if(id==='../common'||id==='../common/index.js'){
        const platform=await load(path.join(audit,'src/common/constants/platform.ts'));await platform.evaluate();
        return stub('common',{...Object.fromEntries(Object.keys(platform.namespace).map(k=>[k,platform.namespace[k]])),logger:{warn:s=>warnings.push(s)},processColorsInProps:updates=>{native.events.push('colors');updates.backgroundColor=0xff123456;}});
      }
      if(id==='../common/constants')return load(path.join(audit,'src/common/constants/platform.ts'));
      if(id==='../featureFlags'||id==='../featureFlags/index.js')return stub('flags',{getStaticFeatureFlag:name=>{calls.push(name);assert.equal(name,'USE_ANIMATION_BACKEND');return backend;}});
      if(id==='../fabricUtils')return stub(id,{getShadowNodeWrapperFromRef:ref=>ref.wrapper});
      if(id==='../mutables')return stub(id,{makeMutable:x=>({get value(){refReads++;return x;},set value(v){x=v;}})});
      if(id==='../platformFunctions/findNodeHandle')return stub(id,{findNodeHandle:()=>7});
      throw Error(`Unexpected dependency ${id} from ${ref.identifier}`);
    });
    return m;
  }
  // Evaluate actual enum before linking consumers (SyntheticModule requires values).
  const runtime=await load(runtimeFile);await runtime.evaluate();
  const mod=await load(path.join(opts.entryRoot || audit,entry));await mod.evaluate();
  const refmod=await load(path.join(audit,'src/hook/useAnimatedRef.ts'));await refmod.evaluate();
  const ref=refmod.namespace.useAnimatedRef();ref({wrapper:{tag:'old'}});
  const uiRef=serializableMappingCache.get(ref)?.__init();
  ref({wrapper:{tag:'current'}}); // Existing UI ref must resolve CURRENT host.
  const invoke=()=>mod.namespace.setNativeProps(uiRef??ref,{transform:[{translateY:0}],backgroundColor:'test-color'});
  return {native,warnings,calls,invoke,get refReads(){return refReads;}};
}
for(const entry of ['src/platformFunctions/setNativeProps.ts','lib/module/platformFunctions/setNativeProps.js']){
  for(const mode of ['draw','running','idle'])await test(`${entry}: Android backend=false ${mode} delivers without external event`,async()=>{
    const h=await fixture(entry,{mode});h.invoke();
    if(mode!=='idle') {
      assert.equal(h.native.pending.at(-1)?.updates.transform[0].translateY,0,'queued last zero is not visible delivery');
    }
    assert.equal(h.native.pending[0]?.shadowNodeWrapper.tag??'current','current');
    if(mode!=='idle'){assert.equal(h.native.visible.get('current'),274);assert.equal(h.native.drains,0,'helper owns deferral');}
    h.native.normalFrame();
    assert.equal(h.native.visible.get('current'),0,'last visible 274 must become 0 by normal native frame');
    assert.equal(h.native.visible.get('old'),274,'old ref host untouched');
    assert.equal(h.native.requests,1,'exactly one library-owned helper request');assert.equal(h.native.drains,1);
    assert.equal(h.native.pending.length,0);assert.equal(h.warnings.length,0);
    assert.deepEqual(h.native.events.slice(0,3),['colors','enqueue','helper']);
    assert.equal(h.calls.length,1,'flag evaluated once on JS module, never inside worklet');
    assert.equal(h.refReads,1,'current animated ref resolved once');
    h.invoke();assert.equal(h.calls.length,1);assert.equal(h.native.requests,2);
  });
  for(const backend of [false,true])for(const os of ['android','ios','web','windows']){
    if(!backend&&os==='android')continue;
    await test(`${entry}: ${os} backend=${backend} unchanged`,async()=>{
      const h=await fixture(entry,{os,backend,mode:'idle'});h.invoke();h.native.normalFrame();
      assert.equal(h.native.requests,0);assert.equal(h.native.drains,0);assert.equal(h.native.visible.get('current'),274);
      if(os==='web'||os==='windows'){assert.equal(h.native.pending.length,0);assert.match(h.warnings[0],/not supported on this configuration/);}else{assert.equal(h.native.pending.length,1);assert.equal(h.warnings.length,0);}
    });
  }
  await test(`${entry}: ReactNative runtime warns before enqueue/flush/ref`,async()=>{
    const h=await fixture(entry,{kind:1});h.invoke();assert.equal(h.native.pending.length,0);assert.equal(h.native.requests,0);assert.equal(h.native.events.length,0);assert.equal(h.refReads,0,'JS warning returns before resolving ref');assert.deepEqual(h.warnings,['setNativeProps() can only be used on the UI runtime.']);
  });
  await test(`${entry}: Jest route preserved`,async()=>{
    const h=await fixture(entry,{jest:true});h.invoke();assert.equal(h.native.pending.length,0);assert.equal(h.native.requests,0);assert.deepEqual(h.warnings,['setNativeProps() is not supported with Jest.']);
  });
}

if (!original) {
  const [TS, JS, MAP] = paths;
  const apply = files => repair.repairPinned451({version:'4.5.1',files});
  await test('known triple is pure, byte-idempotent and accepts all eight partial states', () => {
    const snapshot=JSON.stringify(originals);
    for(let mask=0;mask<8;mask++) {
      const partial=Object.fromEntries(paths.map((p,i)=>[p,mask & (1<<i) ? repaired[p] : originals[p]]));
      assert.deepEqual(apply(partial),repaired);
    }
    assert.deepEqual(apply(repaired),repaired);
    assert.equal(JSON.stringify(originals),snapshot);
  });
  await test('unknown versions, each unknown source/map hash and incomplete inputs fail closed', () => {
    for(const version of ['4.5.0','4.5.2','4.5.5','4.5.1-custom',undefined])
      assert.throws(()=>repair.repairPinned451({version,files:originals}),/Unsupported/);
    for(const p of paths) {
      assert.throws(()=>apply({...originals,[p]:originals[p]+' '}),/Unknown source/);
      const missing={...originals};delete missing[p];assert.throws(()=>apply(missing),/exactly/);
    }
    assert.throws(()=>apply({...originals,extra:''}),/exactly/);
    const corrupted=JSON.parse(originals[MAP]);corrupted.sourceRoot='../../wrong';
    assert.throws(()=>apply({...originals,[MAP]:JSON.stringify(corrupted)}),/Unknown source/);
  });
  await test('source map preserves every original segment, name and unchanged line; additions are unmapped', () => {
    const before=JSON.parse(originals[MAP]), after=JSON.parse(repaired[MAP]);
    assert.deepEqual({...after,mappings:''},{...before,mappings:''});
    assert.ok(!Object.hasOwn(after,'sourcesContent'));
    assert.match(repaired[JS],/sourceMappingURL=setNativeProps\.js\.map/);
    const mappings=text=>{
      const decoder=ts.decodeMappings(text), result=Array.from(decoder);
      assert.equal(decoder.error,undefined);return result;
    };
    // Independent TypeScript decoder, and content-based subsequence alignment:
    // no production splice offsets/codec are reused as the mapping oracle.
    const align=(oldText,newText,normalize=x=>x)=>{
      const newer=newText.split('\n');let cursor=0;
      return oldText.split('\n').map(oldLine=>{
        while(cursor<newer.length && normalize(newer[cursor])!==normalize(oldLine))cursor++;
        assert.ok(cursor<newer.length,'original line retained: '+oldLine);
        return cursor++;
      });
    };
    const sourceLines=align(originals[TS],repaired[TS]);
    const generatedLines=align(originals[JS],repaired[JS],x=>x.replace('IS_ANDROID, ',''));
    const oldSegments=mappings(before.mappings), newSegments=mappings(after.mappings);
    for(const segment of oldSegments) {
      const expected={...segment,generatedLine:generatedLines[segment.generatedLine]};
      if(segment.sourceLine!==undefined) expected.sourceLine=sourceLines[segment.sourceLine];
      const oldLine=originals[JS].split('\n')[segment.generatedLine];
      const newLine=repaired[JS].split('\n')[expected.generatedLine];
      if(oldLine!==newLine && segment.generatedCharacter>=9)expected.generatedCharacter+=newLine.length-oldLine.length;
      assert.ok(newSegments.some(s=>JSON.stringify(s)===JSON.stringify(expected)),JSON.stringify(expected));
    }
    const mappedLines=new Set(generatedLines);
    for(const segment of newSegments) {
      assert.ok(mappedLines.has(segment.generatedLine),'new JS lines have no mappings');
      if(segment.sourceLine!==undefined) assert.ok(sourceLines.includes(segment.sourceLine),'new TS lines have no fabricated mappings');
    }
    // Read actual positions for every existing named token, not just line counts.
    for(const segment of newSegments.filter(s=>s.nameIndex!==undefined)) {
      const name=after.names[segment.nameIndex];
      const baseline=oldSegments.find(s=>s.nameIndex===segment.nameIndex && sourceLines[s.sourceLine]===segment.sourceLine && s.sourceCharacter===segment.sourceCharacter && generatedLines[s.generatedLine]===segment.generatedLine);
      assert.ok(baseline,name+' original named segment retained');
      assert.equal(repaired[TS].split('\n')[segment.sourceLine][segment.sourceCharacter],originals[TS].split('\n')[baseline.sourceLine][baseline.sourceCharacter],name+' source character');
      assert.equal(repaired[JS].split('\n')[segment.generatedLine][segment.generatedCharacter],originals[JS].split('\n')[baseline.generatedLine][baseline.generatedCharacter],name+' generated character');
    }
    const importLine=repaired[JS].split('\n').findIndex(s=>s.includes('import { IS_ANDROID,'));
    const boundary=newSegments.find(s=>s.generatedLine===importLine && s.generatedCharacter===9);
    assert.equal(boundary.sourceLine,undefined,'new import identifier explicitly unmapped');
  });
  function diskFixture(fn) {
    const prefix=path.join(repo,'tests','.reanimated-native-props-');
    const directory=fs.mkdtempSync(prefix);
    try {
      fs.writeFileSync(path.join(directory,'package.json'),JSON.stringify({name:'react-native-reanimated',version:'4.5.1'}));
      for(const p of paths) {fs.mkdirSync(path.dirname(path.join(directory,p)),{recursive:true});fs.writeFileSync(path.join(directory,p),originals[p]);}
      return fn(directory);
    } finally {
      assert.ok(path.resolve(directory).startsWith(path.resolve(prefix)));
      fs.rmSync(directory,{recursive:true,force:true});
    }
  }
  const readTriple=directory=>Object.fromEntries(paths.map(p=>[p,fs.readFileSync(path.join(directory,p),'utf8')]));
  const allFiles=directory=>fs.readdirSync(directory,{recursive:true}).filter(p=>fs.statSync(path.join(directory,p)).isFile()).map(p=>p.split(path.sep).join('/')).sort();
  await test('filesystem publication is exact and second run performs no writes', () => diskFixture(directory=>{
    const result=repair.repairPackage(directory);
    assert.deepEqual(result.changed,paths.filter(p=>originals[p]!==repaired[p]));
    assert.deepEqual(readTriple(directory),repaired);
    const denyWrite={...fs,openSync(p,flags,...rest){assert.equal(flags,'wx');return fs.openSync(p,flags,...rest);},writeFileSync(){assert.fail('idempotent run wrote a file');},renameSync(){assert.fail('idempotent run renamed a file');}};
    assert.deepEqual(repair.repairPackage(directory,{fs:denyWrite}).changed,[]);
    assert.deepEqual(allFiles(directory),[...paths,'package.json'].sort());
  }));
  await test('unknown version or any source/map aborts disk preflight before staging', () => {
    for(const corrupt of ['package.json',...paths])diskFixture(directory=>{
      const p=path.join(directory,corrupt);
      fs.writeFileSync(p,corrupt==='package.json' ? '{"version":"4.5.5"}' : originals[corrupt]+' ');
      const snapshot=readTriple(directory);
      assert.throws(()=>repair.repairPackage(directory,{fs:{...fs,writeFileSync(){assert.fail('wrote before complete preflight');}}}),/Unsupported|Unknown source/);
      assert.deepEqual(readTriple(directory),snapshot);
      assert.deepEqual(allFiles(directory),[...paths,'package.json'].sort());
    });
  });
  await test('all filesystem partial states converge to the same repaired triple', () => {
    for(let mask=0;mask<8;mask++)diskFixture(directory=>{
      for(let i=0;i<3;i++)if(mask&(1<<i))fs.writeFileSync(path.join(directory,paths[i]),repaired[paths[i]]);
      repair.repairPackage(directory);assert.deepEqual(readTriple(directory),repaired);
    });
  });
  await test('staging failure changes no targets; publication failure rolls back previous targets', () => {
    for(const operation of ['writeFileSync','renameSync'])for(let failAt=1;failAt<=(operation==='writeFileSync'?6:3);failAt++)diskFixture(directory=>{
      let calls=0;
      const faulty={...fs,[operation](...args){if(++calls===failAt)throw Error('injected '+operation);return fs[operation](...args);}};
      assert.throws(()=>repair.repairPackage(directory,{fs:faulty}),/injected/);
      assert.deepEqual(readTriple(directory),originals);
      assert.deepEqual(allFiles(directory),[...paths,'package.json'].sort());
    });
  });
  await test('installer skips only an absent dependency tree, and fails for an incomplete or unknown installed package', () => diskFixture(directory=>{
    assert.equal(repair.repairReanimatedNativeProps(directory),false);
    fs.mkdirSync(path.join(directory,'node_modules'));
    assert.throws(()=>repair.repairReanimatedNativeProps(directory),{code:'ENOENT'});
    const packageRoot=path.join(directory,'node_modules','react-native-reanimated');fs.mkdirSync(packageRoot);
    fs.writeFileSync(path.join(packageRoot,'package.json'),'{"version":"4.5.5"}');
    for(const p of paths) {fs.mkdirSync(path.dirname(path.join(packageRoot,p)),{recursive:true});fs.writeFileSync(path.join(packageRoot,p),originals[p]);}
    assert.throws(()=>repair.repairReanimatedNativeProps(directory),/Unsupported Reanimated version/);
    fs.writeFileSync(path.join(packageRoot,'package.json'),'{"version":"4.5.1"}');
    assert.equal(repair.repairReanimatedNativeProps(directory).version,'4.5.1');
    assert.deepEqual(readTriple(packageRoot),repaired);
  }));
  await test('installed entrypoints execute directly after the installer and after an idempotent rerun', async () => {
    const prefix=path.join(repo,'tests','.reanimated-native-props-');
    const directory=fs.mkdtempSync(prefix),packageRoot=path.join(directory,'node_modules','react-native-reanimated');
    try {
      fs.mkdirSync(packageRoot,{recursive:true});
      fs.writeFileSync(path.join(packageRoot,'package.json'),'{"version":"4.5.1"}');
      for(const p of paths) {fs.mkdirSync(path.dirname(path.join(packageRoot,p)),{recursive:true});fs.writeFileSync(path.join(packageRoot,p),originals[p]);}
      for(let pass=0;pass<2;pass++) {
        repair.repairReanimatedNativeProps(directory);
        assert.deepEqual(readTriple(packageRoot),fullyRepaired);
        for(const entry of paths.slice(0,2)) {
          // No repaired string substitution: execute the installed file bytes.
          const h=await fixture(entry,{fromDisk:true,entryRoot:packageRoot});h.invoke();
          assert.equal(h.native.pending.at(-1).updates.transform[0].translateY,0);
          assert.equal(h.native.visible.get('current'),274);
          h.native.normalFrame();assert.equal(h.native.visible.get('current'),0);
          assert.equal(h.native.requests,1);assert.equal(h.native.drains,1);
          assert.equal(h.native.visible.get('old'),274);assert.equal(h.refReads,1);
        }
      }
    } finally {
      assert.ok(path.resolve(directory).startsWith(path.resolve(prefix)));
      fs.rmSync(directory,{recursive:true,force:true});
    }
  });
  await test('exclusive lock prevents concurrent writers', () => diskFixture(directory=>{
    const lock=path.join(directory,'.reanimated-native-props-repair.lock');fs.writeFileSync(lock,'');
    assert.throws(()=>repair.repairPackage(directory),{code:'EEXIST'});
    assert.deepEqual(readTriple(directory),originals);fs.unlinkSync(lock);
  }));
  await test('external change during staging is detected before publication', () => diskFixture(directory=>{
    let touched=false;
    const faulty={...fs,writeFileSync(...args){fs.writeFileSync(...args);if(!touched){touched=true;fs.appendFileSync(path.join(directory,paths[2]),' ');}}};
    assert.throws(()=>repair.repairPackage(directory,{fs:faulty}),/changed during repair/);
    assert.equal(fs.readFileSync(path.join(directory,paths[0]),'utf8'),originals[paths[0]]);
    assert.equal(fs.readFileSync(path.join(directory,paths[1]),'utf8'),originals[paths[1]]);
    assert.equal(fs.readFileSync(path.join(directory,paths[2]),'utf8'),originals[paths[2]]+' ');
  }));
}

}
