import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require(process.env.PRIVACY_TYPESCRIPT || 'typescript');
const root = path.resolve(import.meta.dirname, '..');
const sourceRoot = process.env.PRIVACY_SOURCE_ROOT || root;
function load(relative, mocks = {}, extra = '') {
  const file = path.join(sourceRoot, relative);
  let source = fs.readFileSync(file, 'utf8');
  source += extra;
  const js = ts.transpileModule(source, {fileName: file, compilerOptions: {module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022}}).outputText;
  const exports = {};
  const fallback = new Proxy({}, {get: (_, key) => key === '__esModule' ? true : () => { throw new Error('Unexpected dependency ' + String(key)); }});
  vm.runInNewContext(js, {exports, require: id => {
    if (id in mocks) return mocks[id];
    if (id === '@/lib/model-artifact-lifecycle') return load('src/lib/model-artifact-lifecycle.ts');
    return fallback;
  }, console, process, setInterval, clearInterval, setTimeout, Promise, Error}, {filename: file});
  return exports;
}
const names = ['ggml-tiny-q5_1.bin', 'ggml-silero-v6.2.0.bin', 'translation.bin'];
const sizes = [32152673, 885098, 1600000000];
function service(kind, failure = 'hash') {
  const files = new Map(names.map((n,i) => [n, sizes[i]]));
  let hashCalls = 0, markerReads = 0, markerWrites = 0, downloads = 0;
  class Directory { constructor(...parts) { this.uri = parts.map(p => p.uri || p).join('/'); } }
  class File {
    constructor(dir, name) { this.parentDirectory = dir; this.name = name; this.uri = dir.uri + '/' + name; }
    get exists() { return files.has(this.name); }
    get size() { return files.get(this.name) || 0; }
    get lastModified() { return 1; } get creationTime() { return 1; }
    async text() { markerReads++; if (failure === 'marker-read') throw new Error('marker read'); return 'invalid'; }
    write() { markerWrites++; if (failure === 'marker-write') throw new Error('marker write'); files.set(this.name, 10); }
    async move(target) { files.set(target.name, files.get(this.name)); files.delete(this.name); }
    delete() { if (failure === 'delete') throw new Error('delete'); files.delete(this.name); }
  }
  if (failure === 'marker-read') for (const n of names) files.set(n + '.sha256', 12);
  const mocks = {
    'expo-file-system': {Directory, File, Paths: {document: 'document'}},
    'caption-media': {default: {sha256: async uri => { hashCalls++; if(failure === 'hash') throw new Error('hash read'); return uri.includes(names[0]) ? '818710568da3ca15689e31a743197b520007872ff9576237bda97bd1b469c3d7' : uri.includes(names[1]) ? '2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987' : 'other-hash'; }}},
    '@/lib/model-verification-lease': {sameModelFileIdentity: () => true},
    'caption-translation': {default: {isLocalTranslationSupported: async () => false}, TRANSLATION_RELEASE_CONTRACT: {id:'natural', label:'Natural', fileName: names[2], downloadBytes:sizes[2], sha256:'other-hash'}},
    '@/lib/model-verification': {modelVerificationMarkerMatches: () => false, modelVerificationMarkerIdentityMatches: () => false, encodeModelVerificationMarker: () => 'marker'},
    '@/services/verified-model-download': {downloadVerifiedModel: async () => {downloads++;}, ModelDownloadIntegrityError: class extends Error {}, ModelDownloadPausedError: class extends Error {}, ModelDownloadTransferError: class extends Error {}},
  };
  const relative = kind === 'caption' ? 'src/services/transcription.ts' : 'src/services/caption-translation.ts';
  const extra = kind === 'caption'
    ? '\nexport function __busy(value: boolean) { activeModelUsers = value ? 1 : 0; }\n'
    : '\nexport function __busy(value: boolean) { activeTranslation = value ? {id: Symbol(), cancelled: false} : undefined; }\n';
  const api = load(relative, mocks, extra);
  return {api, files, counts: () => ({hashCalls, markerReads, markerWrites, downloads}),
    list: () => (kind === 'caption' ? (api.listStoredTranscriptionModels || api.listDownloadedTranscriptionModels) : (api.listStoredNaturalTranslationModel || api.listDownloadedNaturalTranslationModel))(),
    remove: () => (kind === 'caption' ? api.removeDownloadedTranscriptionModels : api.removeDownloadedNaturalTranslationModel)()};
}
for (const kind of ['caption','translation']) {
  for (const failure of ['hash','marker-read','marker-write']) test(kind + ' storage inventory isolates ' + failure, async () => {
    const s = service(kind, failure);
    const before = [...s.files];
    const result = await s.list();
    const expected = kind === 'caption' ? sizes[0]+sizes[1] : sizes[2];
    assert.equal(result[0].sizeBytes, expected + (failure === 'marker-read' ? (kind === 'caption' ? 24 : 12) : 0));
    assert.equal(result[0].status, 'stored');
    assert.deepEqual(s.counts(), {hashCalls:0, markerReads:0, markerWrites:0, downloads:0});
    assert.deepEqual([...s.files], before);
  });
  test(kind + ' partial bytes and owned cleanup on unsupported runtime', async () => {
    const s = service(kind);
    s.files.clear();
    const own = kind === 'caption' ? names[0] : names[2];
    for(const [suffix,size] of [['.download',43],['.download.resume.json',9],['.download.resume.json.writing',5],['.download.chunk',7],['.download.chunk.offset',2],['.sha256',11],['.sha256.download',3]]) s.files.set(own+suffix,size);
    s.files.set('unrelated.bin.download', 101);
    s.files.set('saved-project.json', 99);
    if(kind === 'caption') s.files.set('ggml-base-q5_1.bin.download', 13);
    const rows = await s.list();
    assert.equal(rows[0].sizeBytes, kind === 'caption' ? 93 : 80);
    assert.equal(rows[0].status, 'incomplete');
    assert.ok(s.files.has(own+'.download'));
    s.api.__busy(true);
    await assert.rejects(s.remove(), /Wait/);
    assert.ok(s.files.has(own+'.download'));
    s.api.__busy(false);
    await s.remove();
    assert.deepEqual([...s.files], [['unrelated.bin.download',101],['saved-project.json',99]]);
    assert.equal((await s.list()).length,0);
  });
  test(kind + ' readiness still fails closed', async () => {
    const s = service(kind, 'hash');
    const ready = kind === 'caption' ? s.api.listDownloadedTranscriptionModels : s.api.listDownloadedNaturalTranslationModel;
    await assert.rejects(ready(), /hash read/);
    assert.equal(s.counts().hashCalls,1);
  });
  for (const failure of ['marker-read','marker-write']) test(kind + ' readiness preserves '+failure+' failures', async () => {
    const s=service(kind,failure);
    const ready=kind==='caption'?s.api.listDownloadedTranscriptionModels:s.api.listDownloadedNaturalTranslationModel;
    await assert.rejects(ready(),new RegExp(failure==='marker-read'?'marker read':'marker write'));
    assert.equal(s.counts().downloads,0);
    assert.ok(s.files.has(kind==='caption'?names[0]:names[2]));
  });
  test(kind + ' valid readiness is retained without redownload', async () => {
    const s=service(kind,'none');
    const ready=kind==='caption'?s.api.listDownloadedTranscriptionModels:s.api.listDownloadedNaturalTranslationModel;
    assert.equal((await ready())[0].status,'ready');
    await s.list();
    assert.equal((await ready())[0].status,'ready');
    assert.equal(s.counts().downloads,0);
  });
}
function deferred() { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; }
const flush = async () => { for(let i=0;i<10;i++) await Promise.resolve(); };
function mountScreen() {
  let slots=[], effects=[], cursor=0, mounted=true, lateUpdates=0, tree;
  const alerts=[], calls={caption:0,translation:0}, requests={caption:[],translation:[]};
  const removals={caption:deferred(),translation:deferred()};
  const react = {
    useState(initial) { const i=cursor++; if(!(i in slots)) slots[i]=typeof initial==='function'?initial():initial;
      return [slots[i], value => { if(!mounted){lateUpdates++;return;} slots[i]=typeof value==='function'?value(slots[i]):value; render(); }]; },
    useRef(initial) { const i=cursor++; if(!(i in slots)) slots[i]={current:initial}; return slots[i]; },
    useEffect(fn,deps) { const i=cursor++; const previous=slots[i]; if(!previous || deps.some((v,j)=>!Object.is(v,previous.deps[j]))) { effects.push(()=>{previous?.cleanup?.(); slots[i]={deps,cleanup:fn()};}); } },
  };
  const jsx = (type,props) => typeof type === 'function' ? type(props) : {type,props};
  const list = kind => () => {calls[kind]++; const d=deferred();requests[kind].push(d);return d.promise;};
  const captionList=list('caption'), translationList=list('translation');
  const mocks = {'react':react,'react/jsx-runtime':{jsx,jsxs:jsx}, 'expo-router':{useRouter:()=>({push(){}})},
    'react-native':{Alert:{alert:(...args)=>alerts.push(args)}, Pressable:'Pressable',Text:'Text',View:'View'},
    '@/components/spring-scroll-view':{SpringScrollView:'ScrollView'},
    '@/lib/ui-theme':{chrome:{radius:{md:4,lg:8}}},
    '@/services/transcription':{listStoredTranscriptionModels:captionList,listDownloadedTranscriptionModels:captionList,removeDownloadedTranscriptionModels:()=>removals.caption.promise},
    '@/services/caption-translation':{listStoredNaturalTranslationModel:translationList,listDownloadedNaturalTranslationModel:translationList,removeDownloadedNaturalTranslationModel:()=>removals.translation.promise},
  };
  if(fs.existsSync(path.join(sourceRoot,'src/hooks/use-model-inventory.ts'))) mocks['@/hooks/use-model-inventory']=load('src/hooks/use-model-inventory.ts',mocks);
  const Screen=load('src/app/privacy.tsx',mocks).default;
  function render(){cursor=0;tree=Screen();const pending=effects;effects=[];pending.forEach(fn=>fn());}
  render();
  function nodes(node=tree) {if(!node || typeof node!=='object') return []; return [node,...[node.props?.children].flat(Infinity).flatMap(n=>nodes(n))];}
  function texts(node=tree) { if(typeof node==='string'||typeof node==='number') return String(node); if(!node)return '';return [node.props?.children].flat(Infinity).map(n=>texts(n)).join(' '); }
  return {requests,calls,removals,alerts,text:()=>texts(), click(label){const n=nodes().find(n=>n.type==='Pressable'&&texts(n).includes(label));assert.ok(n,'button '+label);n.props.onPress();},
    unmount(){mounted=false; slots.forEach(s=>s?.cleanup?.());}, late:()=>lateUpdates};
}
for(const kind of ['caption','translation']) {
  const label=kind==='caption'?'caption':'natural translation';
  test('Privacy '+kind+' actual effect rejection shows error independently', async () => {
    const m=mountScreen(); await flush();
    m.requests[kind][0].reject(new Error('metadata I/O'));
    const other=kind==='caption'?'translation':'caption';
    m.requests[other][0].resolve([{id:'x',sizeBytes:123,status:'incomplete'}]);
    await flush();
    assert.match(m.text(),new RegExp('Could not load '+label+' storage'));
    assert.match(m.text(),new RegExp('Remove '+(kind==='caption'?'natural translation':'caption')+' model'));
    m.unmount();
  });
  test('Privacy '+kind+' mounted loading, independent failure and Retry', async () => {
    const m=mountScreen(); await flush();
    assert.match(m.text(), /Loading caption model/);
    assert.match(m.text(), /Loading natural translation model/);
    m.requests[kind][0].reject(new Error('metadata denied'));
    const other=kind==='caption'?'translation':'caption';
    m.requests[other][0].resolve([]);
    await flush();
    assert.match(m.text(), new RegExp('Could not load '+label+' storage'));
    m.click('Retry '+label); await flush();
    assert.equal(m.calls[kind],2);
    assert.equal(m.calls[other],1);
    m.requests[kind][1].resolve([{id:'x',label:'x',sizeBytes:77,status:'incomplete'}]);
    await flush();
    assert.match(m.text(), /unfinished download/);
    assert.doesNotMatch(m.text(), /Could not load/);
    m.unmount();
  });
  for(const fails of [true,false]) test('Privacy '+kind+' removal '+(fails?'failure retains bytes':'success clears bytes'), async () => {
    const m=mountScreen(); await flush();
    m.requests.caption[0].resolve([{id:'x',sizeBytes:77,status:'incomplete'}]);
    m.requests.translation[0].resolve([{id:'y',sizeBytes:99,status:'incomplete'}]);
    await flush();
    m.click('Remove '+label+' model');
    m.alerts.at(-1)[2].find(b=>b.style==='destructive').onPress();
    if(fails)m.removals[kind].reject(new Error('busy'));else m.removals[kind].resolve();
    await flush();
    if(fails){assert.match(m.text(),new RegExp('Remove '+label+' model'));assert.match(m.alerts.at(-1)[0],/Could not remove/);}
    else assert.doesNotMatch(m.text(),new RegExp('Remove '+label+' model'));
    assert.match(m.text(), new RegExp('Remove '+(kind==='caption'?'natural translation':'caption')+' model'));
    m.unmount();
  });
  test('Privacy '+kind+' late success/rejection/removal after unmount', async () => {
    for(const reject of [false,true]) {
      const m=mountScreen(); await flush(); m.unmount();
      for(const k of ['caption','translation']) {if(reject)m.requests[k][0].reject(new Error('late'));else m.requests[k][0].resolve([]);}
      await flush();assert.equal(m.late(),0);
    }
    const m=mountScreen(); await flush();
    for(const k of ['caption','translation'])m.requests[k][0].resolve([{id:'x',sizeBytes:1,status:'incomplete'}]);
    await flush();m.click('Remove '+label+' model');m.alerts.at(-1)[2].find(b=>b.style==='destructive').onPress();m.unmount();
    m.removals[kind].resolve();await flush();assert.equal(m.late(),0);
  });
}

