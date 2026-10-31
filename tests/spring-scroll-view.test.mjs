import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

const rnSource = process.env.SPRING_RN_SOURCE ?? new URL('../node_modules/react-native/Libraries/Components/ScrollView/ScrollView.js', import.meta.url);
const root = new URL('../src/components/', import.meta.url);
const compile = (url) => ts.transpileModule(readFileSync(url, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  fileName: url.pathname,
}).outputText;
const componentCode = compile(new URL('spring-scroll-view.tsx', root));
const gestureCode = compile(new URL('spring-scroll-gesture.ts', root));
const controllerCode = compile(new URL('scroll-spring-controller.ts', root));
const policyCode = compile(new URL('../lib/scroll-spring-policy.ts', root));
const plain = value => JSON.parse(JSON.stringify(value));

// Compile the installed engine, including the actual UI mutable's modify path.
// Only spring construction is a probe: these tests establish setter behavior,
// initialization and completion safety, not physical spring trajectories.
const reanimatedSource = process.env.SPRING_REANIMATED_SOURCE
  ? pathToFileURL(process.env.SPRING_REANIMATED_SOURCE)
  : new URL('../node_modules/react-native-reanimated/src/valueSetter.ts', import.meta.url);
const setterCode = compile(reanimatedSource);
const mutablesCode = compile(new URL('mutables.ts', reanimatedSource));
function installedEngine() {
  const frames = [], setter = {}, mutables = {};
  const environment = { global: { _getAnimationTimestamp: () => 1 },
    requestAnimationFrame: callback => frames.push(callback), __DEV__: false };
  runInNewContext(setterCode, { ...environment, exports: setter });
  runInNewContext(mutablesCode, { ...environment, exports: mutables, require(id) {
    if (id === './valueSetter') return setter;
    if (id === './featureFlags') return { getStaticFeatureFlag: () => false };
    if (id === './common') return { IS_JEST: false, SHOULD_BE_USE_WEB: false };
    if (id === './reactUtils') return {};
    if (id === 'react-native-worklets') return {};
    throw Error(`Unexpected engine dependency ${id}`);
  } });
  return { mutable: mutables.makeMutableUI, frames };
}

function harness(initial = {}, platform = 'android', engineOptions) {
  let cursor = 0, tree, props = initial, now = 0, collecting, running = false, deferred = false;
  let slots = [];
  const primarySlots = slots, effects = [], reactions = [], jobs = [], listeners = new Map(), queries = [];
  // Explicit native removal is separate from React ref detach: an animated ref
  // retains its wrapper on null in the pinned engine. This is a host-existence
  // model, not a simulation of Fabric or proof about a physical device.
  const removedHosts = new WeakSet();
  const calls = { commands: [], springs: [], starts: [], cancels: [], warnings: [], props: [], pan: 0, native: 0 };
  const engine = engineOptions ? installedEngine() : undefined;
  let engineModifyDepth = 0;
  const equal = (a,b) => a && b && a.length === b.length && a.every((v,i) => Object.is(v,b[i]));
  const memo = (fn,deps) => { const i = cursor++; if (!slots[i] || !equal(slots[i].deps,deps)) slots[i] = { value: fn(), deps }; return slots[i].value; };
  function react() {
    // UI mappers run after the current transaction; completion callbacks still
    // run synchronously inside valueSetter and must pass the reentry guard.
    if (running || engineModifyDepth) return;
    running = true;
    try { for (const r of reactions) { collecting = r; const value = r.prepare(); collecting = undefined;
      if (!Object.is(value,r.previous)) { const previous = r.previous; r.previous = value; r.run(value,previous); }
    } } finally { collecting = undefined; running = false; }
  }
  const mutable = (value) => {
    if (engine) {
      const shared = engine.mutable(value), modify = shared.modify;
      let modifying = false;
      shared.modify = (updater, forceUpdate = true) => {
        assert.equal(modifying, false, 'shared value modify must not reenter its own transaction');
        modifying = true;engineModifyDepth++;
        try { return modify(updater, forceUpdate); } finally {
          modifying = false;engineModifyDepth--;if(!engineModifyDepth)react();
        }
      };
      shared.addListener(1, react);
      return shared;
    }
    let current = value;
    return { modify(updater, forceUpdate = true) {
      const next = updater ? updater(current) : current;
      assert.notEqual(next, undefined, 'UI state modify must retain its state');
      if (next?.animation) { assert.equal(forceUpdate, true); calls.springs.push(next); return; }
      current = next; react();
    }, get value() { return current; }, set value(next) {
      if (next?.animation) { calls.springs.push(next); return; }
      current = next; react();
    } };
  };
  const jsx = (type,props) => {if(type==='GestureDetector'){props.gesture.handlers.handlerTag=777;}return {type,props:props ?? {}};};
  const hooks = {
    createContext(value){return {value,Provider:Symbol('Context.Provider')};},
    useContext:context=>context.value,
    useMemo:memo, useCallback:(fn,deps)=>memo(()=>fn,deps), useRef:value=>memo(()=>({current:value}),[]),
    useState:value=>[memo(()=>typeof value==='function'?value():value,[]),()=>{}],
    useEffect(fn,deps) { const i=cursor++, store=slots; if (!store[i] || !equal(store[i].deps,deps)) effects.push(()=>{
      store[i]?.cleanup?.(); store[i]={deps,setup:fn,cleanup:fn()};
    }); },
  };
  hooks.useLayoutEffect=hooks.useEffect;
  function nativeGesture() {
    calls.native++;
    const gesture={handlers:{isWorklet:[],handlerTag:-1}, config:{}};
    for(const name of ['disallowInterruption','shouldCancelWhenOutside'])
      gesture[name]=value=>{gesture.config[name]=value;return gesture;};
    for(const name of ['onTouchesDown','onTouchesMove','onTouchesUp','onTouchesCancelled','onStart','onEnd','onFinalize'])
      gesture[name]=fn=>{gesture.handlers[name]=fn;return gesture;};
    return gesture;
  }
  const native = { ScrollView:'RN.ScrollView', Platform:{OS:platform}, I18nManager:{isRTL:initial.rtl??false},
    StyleSheet:{flatten:style=>Object.assign({},...[style].flat(Infinity).filter(Boolean))},
    AccessibilityInfo:{isReduceMotionEnabled:()=>({then(resolve,reject){queries.push({resolve,reject});if(!initial.pendingReducedMotion)resolve(initial.initialReducedMotion??false);}}),
      addEventListener:(name,fn)=>{listeners.set(name,fn);return {remove:()=>listeners.delete(name)};}},
    AppState:{currentState:'active',addEventListener:(name,fn)=>{listeners.set('app',fn);return {remove:()=>listeners.delete('app')};}},
  };
  const animated = { View:'Animated.View', ScrollView:'Animated.ScrollView' };
  const reanimated = {default:animated, __esModule:true, makeMutable:mutable,
    useSharedValue:value=>memo(()=>mutable(value),[]), useReducedMotion:()=>initial.initialReducedMotion ?? false,
    useAnimatedRef:()=>memo(()=>{const f=value=>{if(value)f.current=value;return f.current;};f.current=null;return f;},[]),
    useScrollOffset:(ref,offset)=>{memo(()=>null,[]);h.offset=offset;return offset;},
    useAnimatedStyle:fn=>({_animated:fn}),
    useAnimatedReaction(prepare,run) { const r=memo(()=>{const entry={prepare,run,previous:undefined}; reactions.push(entry);return entry;},[]);r.prepare=prepare;r.run=run; },
    cancelAnimation:value=>{calls.cancels.push(value);if(engine)value.value=value.value;},
    withSpring:(to,config,callback)=>{
      const animation={animation:true,to,config,callback};
      if (!engine) return animation;
      Object.assign(animation, { current:to,
        onStart(self,current,timestamp,previous) { calls.starts.push({current,velocity:config.velocity,timestamp,previous});self.current=current; },
        onFrame() { return engineOptions.immediate === true; },
      });
      calls.springs.push(animation);
      return animation;
    },
    dispatchCommand:(ref,name,args)=>calls.commands.push({node:ref(),name,args:plain(args)}),
    setNativeProps:(ref,updates)=>{assert.ok(!('style' in updates),'Reanimated 4.5.1 accepts flattened native props');assert.ok(ref(),'content host must be bound');assert.ok(!removedHosts.has(ref()),'setNativeProps must not target a removed native host');ref().updates=plain(updates);calls.props.push({node:ref(),updates:plain(updates)});},
    scrollTo:(ref,x,y,animated)=>calls.commands.push({node:ref(),name:'scrollTo',args:[x,y,animated]}),
  };
  const worklets={scheduleOnUI:(fn,...args)=>{jobs.push(()=>fn(...args));if(!deferred)flush();}};
  const modules={};
  function load(code) { const exports={};runInNewContext(code,{exports,performance:{now:()=>now},console:{warn:(...args)=>calls.warnings.push(args)},
    require(id){if(id==='react')return hooks;if(id==='react/jsx-runtime')return {jsx,jsxs:jsx};if(id==='react-native')return native;
      if(id==='react-native-reanimated')return reanimated;if(id==='react-native-worklets')return worklets;
      if(id==='react-native-gesture-handler')return {Gesture:{Native:nativeGesture,Pan:()=>{calls.pan++;throw Error('Pan prohibited');}},GestureDetector:'GestureDetector'};
      if(id.includes('scroll-spring-policy'))return modules.policy;if(id==='./spring-scroll-gesture')return modules.gesture;if(id==='./scroll-spring-controller')return modules.controller;
      throw Error(`Unexpected dependency ${id}`);
    }});return exports; }
  function flush(){while(jobs.length)jobs.shift()();}
  const h={calls,queries,mutable,nativeGesture,listeners,flush,jobs,
    removeNativeHost(node=h.node){assert.ok(node?.inner);removedHosts.add(node.inner);},
    setTime(value){now=value;},defer(value=true){deferred=value;},
    render(next=props){slots=primarySlots;props=next;cursor=0;tree=modules.component.SpringScrollView(props);while(typeof tree.type==='function')tree=tree.type(tree.props);
      while(effects.length)effects.shift()();return tree;},
    peer(peerProps,ancestors=[]){const context=modules.component.SpringScrollGestureContext,previous=context?.value;if(context)context.value=ancestors;
      const store=[];slots=store;cursor=0;let peerTree=modules.component.SpringScrollView(peerProps);
      while(typeof peerTree.type==='function')peerTree=peerTree.type(peerTree.props);while(effects.length)effects.shift()();slots=primarySlots;
      if(context)context.value=previous;
      const scroll=peerTree.type==='GestureDetector'?peerTree.props.children:peerTree;
      return {scroll,gesture:peerTree.props.gesture,provided:scroll.props.children,attach(node=makeNode()){scroll.props.ref(node);return node;},unmount(){scroll.props.ref(null);for(const slot of store)slot?.cleanup?.();}};},
    scroll(){return tree.type==='GestureDetector'?tree.props.children:tree;},
    content(){const child=h.scroll().props.children;return child?.type===modules.component.SpringScrollGestureContext?.Provider?child.props.children:child;},
    provided(){return h.scroll().props.children;},
    gesture(){return tree.props.gesture;},
    attach(node=makeNode()){h.node=node;h.scroll().props.ref?.(node);return node;},
    presentation(){return (h.node?.inner&&!removedHosts.has(h.node.inner)?h.node.inner.updates?.transform?.[0]:undefined)??{[props.horizontal?'translateX':'translateY']:0};},
    unmount(){h.scroll().props.ref?.(null);for(const slot of slots)slot?.cleanup?.();if(h.node?.inner)removedHosts.add(h.node.inner);},
    replay(){for(const slot of slots)if(slot?.setup){slot.cleanup?.();slot.cleanup=slot.setup();}},
    geometry(viewport=200,content=600){h.scroll().props.onLayout?.({nativeEvent:{layout:{width:viewport,height:viewport}}});h.scroll().props.onContentSizeChange?.(content,content);},
    touch(name,axis=0,cross=0,count=1){const point={id:1,x:axis,y:axis,absoluteX:props.horizontal?axis:cross,absoluteY:props.horizontal?cross:axis};
      h.gesture().handlers[name]?.({numberOfTouches:count,allTouches:count?[point]:[],changedTouches:[point]});},
    start(){h.touch('onTouchesDown');h.gesture().handlers.onStart?.({});},
    end(success=true){h.touch('onTouchesUp',0,0,0);h.gesture().handlers.onFinalize?.({},success);},
    motion(offset,time){now=time;h.offset.value=offset;},
  };
  modules.policy=load(policyCode);modules.gesture=load(gestureCode);modules.controller=load(controllerCode);modules.component=load(componentCode);
  h.exports=modules.component;h.render();return h;
}
function makeNode(){const inner={updates:{transform:[]}};return {inner,scrollTo(){},scrollToEnd(){},getInnerViewRef(){return inner;},getNativeScrollRef(){return this;},measure(){},flashScrollIndicators(){}};}
function drag(h){h.attach();h.geometry();h.start();h.setTime(10);h.touch('onTouchesMove',20);h.setTime(20);h.touch('onTouchesMove',50);}

test('installed setter skips zero-target assignment but UI modify forces zero-origin initialization',()=>{
  const engine=installedEngine(),offset=engine.mutable(0),seen=[];
  const animation=()=>({current:0,onStart(self,current){seen.push(['start',current]);},
    onFrame(){return false;},callback:finished=>seen.push(['complete',finished])});
  offset.value=animation();
  assert.deepEqual(seen,[['complete',true]],'equal-target assignment completes synchronously before onStart');
  seen.length=0;offset.modify(()=>animation(),true);
  assert.deepEqual(seen,[['start',0]]);assert.equal(offset.value,0);assert.equal(engine.frames.length,1);
});

function interiorFling(h, end) {
  h.attach();h.geometry();h.motion(200,1);h.start();h.motion(end===0?150:250,10);h.end();
  assert.equal(h.calls.springs.length,0,'interior native release needs no decoration');
  h.motion(end===0?50:350,25);h.motion(end,40);
}

for(const horizontal of [false,true])for(const end of [0,400]) {
  test(`installed setter initializes zero-origin momentum: ${horizontal?'horizontal':'vertical'} edge ${end}`,()=>{
    const h=harness({horizontal},'android',{});
    interiorFling(h,end);
    assert.equal(h.calls.springs.length,1);
    assert.equal(h.calls.starts.length,1,'momentum spring must reach the actual engine initializer');
    assert.equal(h.calls.starts[0].current,0,'no seeded displacement');
    assert.equal(h.calls.starts[0].velocity,(end===0?1:-1)*Math.min(3200,Math.sqrt(200*50*50),50*1000/15));
    assert.equal(Math.sign(h.calls.starts[0].velocity),end===0?1:-1);
    assert.ok(Math.abs(h.calls.starts[0].velocity)<=3200);
    assert.equal(Object.values(h.presentation())[0],0,'initializer probe does not simulate physical motion');
    assert.equal(h.calls.commands.length,0);
  });
  test(`synchronous engine completion does not reenter state.modify: ${horizontal?'horizontal':'vertical'} edge ${end}`,()=>{
    const h=harness({horizontal},'android',{immediate:true});
    interiorFling(h,end);
    assert.equal(h.calls.starts.length,1);assert.equal(Object.values(h.presentation())[0],0);
    h.motion(end===0?30:370,50);h.motion(end,60);
    assert.equal(h.calls.springs.length,1,'completed owner cannot decorate later native travel');
    h.start();h.setTime(80);h.touch('onTouchesMove',end===0?50:-50);h.end();
    assert.equal(h.calls.springs.length,2,'next gesture can acquire after immediate completion');
  });
}

test('installed setter leaves untouched and programmatic travel unanimated on both axes and ends',()=>{
  for(const horizontal of [false,true])for(const end of [0,400]){
    const h=harness({horizontal},'android',{});h.attach();h.geometry();h.motion(200,1);h.motion(end,10);
    h.motion(200,20);h.start();h.motion(end===0?150:250,30);h.end();
    h.node.scrollTo(horizontal?{x:end}:{y:end});h.motion(end===0?50:350,40);h.motion(end,50);
    assert.equal(h.calls.springs.length,0);assert.equal(h.calls.starts.length,0);
  }
});

test('immediate displaced release completion permits reacquisition without nested state.modify',()=>{
  const h=harness({},'android',{immediate:true});drag(h);h.end();
  assert.equal(h.calls.starts.length,1);assert.ok(h.calls.starts[0].current>0);
  assert.equal(Object.values(h.presentation())[0],0);
  h.start();h.setTime(40);h.touch('onTouchesMove',60);h.end();assert.equal(h.calls.starts.length,2);
});

test('installed-engine completion respects current epoch, active drag, reset and shared owner',()=>{
  for(const transition of ['epoch','active','command','peer']){
    const h=harness({},'android',{}),shared=h.mutable(0);h.render({springOffset:shared});drag(h);h.end();
    const complete=h.calls.springs[0].callback;
    if(transition==='epoch'){
      h.replay();h.start();h.setTime(40);h.touch('onTouchesMove',60);h.end();
    }else if(transition==='active')h.start();
    else if(transition==='command'){h.node.scrollTo({y:100});shared.value=13;}
    else{
      const peer=h.peer({springOffset:shared});peer.attach();
      peer.scroll.props.onLayout({nativeEvent:{layout:{width:200,height:200}}});peer.scroll.props.onContentSizeChange(600,600);
      peer.gesture.handlers.onTouchesDown({numberOfTouches:1,allTouches:[{absoluteX:0,absoluteY:0}]});peer.gesture.handlers.onStart({});
      shared.value=13;
    }
    const held=shared.value;assert.ok(held>0);complete(false);assert.equal(shared.value,held);
    complete(true);assert.equal(shared.value,held,`${transition} must reject stale completion`);
  }
});

test('completed owner bookkeeping cannot reset presentation acquired by a peer',()=>{
  const h=harness({},'android',{immediate:true}),shared=h.mutable(0);h.render({springOffset:shared});drag(h);h.end();
  assert.equal(shared.value,0);
  const peer=h.peer({springOffset:shared});peer.attach();
  peer.scroll.props.onLayout({nativeEvent:{layout:{width:200,height:200}}});peer.scroll.props.onContentSizeChange(600,600);
  peer.gesture.handlers.onTouchesDown({numberOfTouches:1,allTouches:[{absoluteX:0,absoluteY:0}]});peer.gesture.handlers.onStart({});shared.value=13;
  h.node.scrollTo({y:100});assert.equal(shared.value,13);h.unmount();assert.equal(shared.value,13);peer.unmount();assert.equal(shared.value,0);
});

test('real public ref, native callbacks, native scrolling, axis and one Native recognizer',()=>{
  for(const horizontal of [false,true]){
    const ref={current:null}, callbacks=Object.fromEntries(['onScroll','onScrollBeginDrag','onScrollEndDrag','onMomentumScrollBegin','onMomentumScrollEnd'].map(key=>[key,()=>{}]));
    const style={flex:1},h=harness({horizontal,ref,style,...callbacks});const node=h.attach(),s=h.scroll().props;
    assert.equal(ref.current,node);assert.equal(s.style,style);for(const [name,fn]of Object.entries(callbacks))assert.equal(s[name],fn);
    assert.notEqual(s.scrollEnabled,false);assert.equal(s.overScrollMode,'never');assert.equal(h.calls.native,1);assert.equal(h.calls.pan,0);
    h.geometry();h.start();h.setTime(10);h.touch('onTouchesMove',40);h.setTime(20);h.touch('onTouchesMove',80);
    const transform=h.presentation();assert.ok(transform[horizontal?'translateX':'translateY']>0);
  }
});
test('release survives zero-touch Up, Finalize repeats, and post-finalize cancellation',()=>{
  const h=harness();drag(h);h.end();assert.equal(h.calls.springs.length,1);h.gesture().handlers.onFinalize({},true);h.touch('onTouchesCancelled',0,0,0);
  assert.equal(h.calls.springs.length,1);assert.equal(h.calls.commands.length,0);assert.ok(h.calls.springs[0].config.velocity>0);
});
test('release clamps velocity to 3200 dp/sec and cancels interruption without snapping presentation',()=>{
  const h=harness();h.attach();h.geometry();h.start();h.setTime(0.001);h.touch('onTouchesMove',100);h.end();
  assert.ok(Math.abs(h.calls.springs[0].config.velocity)<=3200);const presented=h.presentation();h.start();
  assert.deepEqual(plain(h.presentation()),plain(presented));
});
test('owned native fling reaching an edge recoils; untouched/programmatic offsets do not',()=>{
  const h=harness();h.attach();h.geometry();h.motion(100,1);h.motion(400,20);assert.equal(h.calls.springs.length,0);
  h.motion(100,30);h.start();h.motion(200,40);h.end();h.motion(350,60);h.motion(400,75);assert.equal(h.calls.springs.length,1);
  assert.ok(h.calls.springs[0].config.velocity<0);
});
test('public commands invalidate atomically before dispatch, retain node/defaults/warning and restore descriptors',()=>{
  const ref={current:null},h=harness({ref}),node=makeNode(),original=Object.getOwnPropertyDescriptors(node);h.attach(node);h.geometry();h.start();h.motion(200,10);h.end();
  node.scrollTo({y:350,animated:false});assert.deepEqual(h.calls.commands.map(c=>[c.name,c.args]),[['scrollTo',[0,350,false]]]);
  h.scroll().props.onMomentumScrollBegin?.({});h.motion(350,20);h.motion(400,30);assert.equal(h.calls.springs.length,0);
  node.scrollTo(25,10,false);node.scrollToEnd();assert.equal(h.calls.warnings.length,1);assert.deepEqual(h.calls.commands.at(-2).args,[10,25,false]);assert.deepEqual(h.calls.commands.at(-1).args,[true]);
  const patched=node.scrollTo;h.unmount();assert.equal(ref.current,null);assert.deepEqual(Object.getOwnPropertyDescriptors(node),original);
  const commands=h.calls.commands.length;patched({y:2});assert.equal(h.calls.commands.length,commands);
});
test('queued command generation cannot target a replacement ref after detach',()=>{
  const h=harness();const first=h.attach();h.defer();first.scrollTo({y:88});const stale=h.jobs.shift();h.scroll().props.ref(null);h.attach();h.flush();stale();assert.equal(h.calls.commands.length,0);
});

for(const transition of ['ref-null','unmount']) {
  test(`lifecycle delayed ${transition} never writes a removed native content host`,()=>{
    const h=harness();drag(h);h.end();
    const old=h.node, writes=h.calls.props.length;
    assert.ok(old.inner.updates.transform[0].translateY>0,'begin with actual recoil presentation');
    h.defer();
    if(transition==='ref-null')h.scroll().props.ref(null);else h.unmount();
    assert.ok(h.jobs.length>0,'deactivation must still be queued when native removal occurs');
    h.removeNativeHost(old);
    assert.doesNotThrow(()=>h.flush(),'queued detach must tolerate native removal before UI execution');
    assert.equal(h.calls.props.length,writes,'removed host receives no presentation or cleanup writes');
    assert.equal(h.calls.commands.length,0);
  });
}

test('lifecycle repeated measurements retain one content binding without redundant native writes',()=>{
  let layouts=0,sizes=0;
  const h=harness({onLayout:()=>layouts++,onContentSizeChange:()=>sizes++});
  h.attach();h.geometry();
  const writes=h.calls.props.length;
  h.geometry();h.geometry();
  assert.equal(layouts,3);assert.equal(sizes,3,'forward every consumer callback');
  assert.equal(h.calls.props.length,writes,'unchanged host/generation needs no readiness republish');
});

test('lifecycle unmount clears shared ownership without needing an absent host to render zero',()=>{
  const h=harness(),shared=h.mutable(0);h.render({springOffset:shared});drag(h);h.end();
  assert.ok(shared.value>0);
  const writes=h.calls.props.length;h.defer();h.unmount();h.flush();
  assert.equal(shared.value,0,'release the shared spring, not only the test-visible host');
  assert.equal(h.calls.props.length,writes,'unmounted host receives no cleanup write');
});

for(const transition of ['replay','same-host','replacement']) {
  test(`lifecycle delayed ${transition} clears presentation on the current live host`,()=>{
    const h=harness();drag(h);h.end();const old=h.node;
    assert.ok(h.presentation().translateY>0);
    h.defer();const writes=h.calls.props.length;
    if(transition==='replay')h.replay();
    else {
      h.scroll().props.ref(null);
      if(transition==='replacement')h.removeNativeHost(old);
      h.attach(transition==='same-host'?old:makeNode());
    }
    const current=h.node;h.flush();
    const updates=h.calls.props.slice(writes);
    assert.ok(updates.some(call=>call.node===current.inner),'current live host must receive presentation cleanup');
    assert.ok(updates.every(call=>call.node===current.inner),'cleanup must target the current live host');
    assert.equal(Object.values(h.presentation())[0]??0,0,'live host cannot retain old recoil');
    h.defer(false);h.geometry();h.start();h.setTime(40);h.touch('onTouchesMove',60);h.end();
    assert.ok(h.presentation().translateY>0,'new generation must still present recoil');
    assert.equal(h.calls.springs.length,2);
  });
}

for(const transition of ['replay','same-host','replacement']) {
  test(`lifecycle stale queued callbacks cannot write after newer ${transition} activation`,()=>{
    const h=harness();drag(h);h.end();const old=h.node;
    h.defer();
    // Capture real scheduled contentReady, geometry and command jobs while the
    // old generation is still current, then execute them after the new one.
    h.geometry();old.scrollTo({y:88});
    if(transition==='replay')h.replay();else h.scroll().props.ref(null);
    const stale=h.jobs.splice(0);assert.ok(stale.length>0);
    if(transition==='replay'){
      // Replay already queued both cleanup and activation. A second replay
      // establishes a strictly newer generation before the captured jobs run.
      h.replay();
    }else{
      if(transition==='replacement')h.removeNativeHost(old);
      h.attach(transition==='same-host'?old:makeNode());
    }
    h.flush();h.defer(false);h.geometry();h.start();h.setTime(40);h.touch('onTouchesMove',60);h.end();
    const current=h.node,held=plain(h.presentation()),writes=h.calls.props.length;
    assert.ok(held.translateY>0);
    for(const job of stale)job();
    assert.equal(h.calls.props.length,writes,'old lifecycle callbacks cannot write the new presentation');
    assert.deepEqual(plain(h.presentation()),held,'old callbacks cannot reset current recoil');
    assert.equal(h.node,current);assert.equal(h.calls.commands.length,0,'old command must not target the new generation');
  });
}
test('nonwritable public methods retain native functionality and disable recoil',()=>{
  const h=harness();const node=makeNode();Object.defineProperty(node,'scrollTo',{writable:false});h.attach(node);h.geometry();h.start();h.setTime(20);h.touch('onTouchesMove',90);h.end();assert.equal(h.calls.springs.length,0);
});
test('shared peer commands, disable and unmount never reset an owner spring',()=>{
  const h=harness();const shared=h.mutable(0);h.render({springOffset:shared});drag(h);h.end();const presented=shared.value;
  const peer=h.peer({springOffset:shared,springOwner:false});const node=peer.attach();node.scrollTo({y:99});peer.unmount();
  assert.equal(shared.value,presented);assert.equal(h.calls.springs.length,1);
  h.render({springOffset:shared,springOwner:false});assert.equal(shared.value,0);assert.ok(presented>0);
});
test('disabled, geometry change, multitouch, and background stop owned decoration',()=>{
  for(const stop of [h=>h.render({scrollEnabled:false}),h=>h.geometry(210,600),h=>h.touch('onTouchesDown',20,0,2),h=>h.listeners.get('app')('background'),h=>h.unmount()]){
    const h=harness();drag(h);stop(h);assert.equal(Object.values(h.presentation())[0]??0,0);
    h.end();assert.equal(h.calls.springs.length,0);
  }
});
test('initial/live reduced motion and stale async results across replay/unmount',async()=>{
  const initial=harness({initialReducedMotion:true});drag(initial);initial.end();assert.equal(initial.calls.springs.length,0);
  const h=harness();drag(h);h.listeners.get('reduceMotionChanged')(true);h.queries[0].resolve(false);await Promise.resolve();h.end();assert.equal(h.calls.springs.length,0);
  h.replay();h.unmount();const cancels=h.calls.cancels.length;h.queries.at(-1).resolve(false);await Promise.resolve();assert.equal(h.calls.cancels.length,cancels);
});
test('contentOffset change revokes a previously owned fling',()=>{
  const h=harness();h.attach();h.geometry();h.start();h.motion(200,10);h.end();h.render({contentOffset:{x:0,y:350}});h.motion(400,30);assert.equal(h.calls.springs.length,0);
});
test('public content host keeps children/content style identity; layout callbacks forward once',()=>{
  for(const horizontal of [false,true]){const seen=[],contentContainerStyle={padding:12,gap:8,flexDirection:'row',...(horizontal?{width:700}:{}),justifyContent:'center'},style={height:250};
    const h=harness({horizontal,style,contentContainerStyle,onLayout:e=>seen.push(e),onContentSizeChange:(...a)=>seen.push(a)}),s=h.scroll().props;
    assert.equal(s.style,style);assert.equal(s.contentContainerStyle,contentContainerStyle);h.geometry();assert.equal(seen.length,2);
  }
});

// This adapter leaves layout with RN rather than reconstructing it. Check the
// actual delegated nodes/styles by identity; do not run the same hand-built Yoga
// layout twice and call that native-layout evidence. Devices remain required.
test('both axes preserve layout-bearing native props and direct cell identity across content shapes',()=>{
  for(const horizontal of [false,true])for(const contentContainerStyle of [
    {padding:12,gap:8},{paddingVertical:1},{flexGrow:1,padding:28,alignItems:'center'},
    {flexGrow:1,padding:10,justifyContent:'space-between'},{width:700,gap:4},
    {minHeight:'100%',paddingBottom:24},
  ])for(const tall of [false,true]){
    const cells=[{key:'a',style:{width:horizontal?240:80,height:tall?300:40}},
      {key:'b',style:{width:horizontal?200:100,height:tall?300:30}},
      {key:'percentage-child',style:{width:700,height:'100%'}}];
    const style={flex:1,minHeight:0},h=harness({horizontal,style,contentContainerStyle,
      children:cells,removeClippedSubviews:true}),native=h.scroll().props;
    assert.equal(native.style,style);assert.equal(native.contentContainerStyle,contentContainerStyle);
    assert.equal(native.horizontal,horizontal);assert.equal(native.removeClippedSubviews,true);
    assert.equal(h.content(),cells,'no additional native content wrapper or copied cells');
  }
});

test('iOS/web and unsupported native constructs pass through layout, callbacks and real refs',()=>{
  for(const platform of ['ios','web','android'])for(const unsupported of [{refreshControl:{}},{stickyHeaderIndices:[0]},{maintainVisibleContentPosition:{minIndexForVisible:0}},{contentContainerStyle:{transform:[{scaleY:-1}]}}]){
    const ref={current:null},style={},contentContainerStyle={},h=harness({ref,style,contentContainerStyle,...unsupported},platform),s=h.scroll();
    assert.equal(s.type,'RN.ScrollView');assert.equal(s.props.ref,ref);assert.equal(s.props.style,style);assert.equal(s.props.contentContainerStyle,unsupported.contentContainerStyle??contentContainerStyle);assert.equal(h.calls.springs.length,0);
  }
});

test('owned scroll recognizers use the pinned native ScrollView ownership preset on both axes',()=>{
  for(const horizontal of [false,true]){
    const h=harness({horizontal}),gesture=h.gesture();
    assert.equal(gesture.config.disallowInterruption,true,'active inner scroll must retain its touch stream');
    assert.equal(gesture.config.shouldCancelWhenOutside,false,'scrolling must continue when a drag leaves its bounds');
    h.render({horizontal:!horizontal});h.replay();
    assert.equal(h.gesture(),gesture,'do not recreate Native ownership during reflow or effect replay');
  }
});

test('supplied Native config remains owned by its caller',()=>{
  const factory=harness(),gesture=factory.nativeGesture();
  gesture.disallowInterruption(false).shouldCancelWhenOutside(true);
  const h=harness({nativeGesture:gesture});
  h.render({nativeGesture:gesture,horizontal:true});h.replay();
  assert.equal(h.gesture(),gesture);
  assert.deepEqual(plain(gesture.config),{disallowInterruption:false,shouldCancelWhenOutside:true});
});

test('supplied Native is the single detector gesture and renderer has stable identity',()=>{
  const factory=harness(),gesture=factory.nativeGesture(),h=harness({nativeGesture:gesture});assert.equal(h.gesture(),gesture);assert.equal(h.calls.pan,0);
  const renderer=h.exports.renderSpringScrollView;assert.equal(renderer({horizontal:true}).type,h.exports.SpringScrollView);h.render();assert.equal(h.exports.renderSpringScrollView,renderer);
});

test('existing UI Native callbacks compose once and restore on unmount/replay',()=>{
  const factory=harness(),g=factory.nativeGesture(),seen=[];
  const down=()=>seen.push('down'),start=()=>seen.push('start'),finalize=()=>seen.push('finalize');
  g.onTouchesDown(down).onStart(start).onFinalize(finalize);const h=harness({nativeGesture:g});drag(h);h.end();
  assert.deepEqual(seen,['down','start','finalize']);h.replay();h.start();h.end();assert.deepEqual(seen,['down','start','finalize','down','start','finalize']);
  h.unmount();assert.equal(g.handlers.onStart,start);assert.equal(g.handlers.onTouchesDown,down);assert.equal(g.handlers.onFinalize,finalize);
});

test('pending reduced-motion query disables recoil until known and queued updates cannot outlive their epoch',()=>{
  const h=harness({pendingReducedMotion:true});drag(h);h.end();assert.equal(h.calls.springs.length,0);
  h.queries[0].resolve(false);h.start();h.setTime(40);h.touch('onTouchesMove',90);h.end();assert.equal(h.calls.springs.length,1);
  h.defer();h.listeners.get('reduceMotionChanged')(false);const stale=h.jobs.shift();h.replay();h.flush();h.listeners.get('reduceMotionChanged')(true);h.flush();stale();
  h.start();h.setTime(50);h.touch('onTouchesMove',90);h.end();assert.equal(h.calls.springs.length,1);
});
test('React callback-ref cleanup runs once; detached/null-native commands issue no request',()=>{
  const events=[],h=harness({ref:node=>{events.push(node);return ()=>events.push('cleanup');}}),node=h.attach();
  node.getNativeScrollRef=()=>null;node.scrollTo();node.scrollToEnd();assert.equal(h.calls.commands.length,0);h.unmount();assert.deepEqual(events,[node,'cleanup']);
});
test('stale spring completion cannot clear a new owner or an interrupted drag',()=>{
  const h=harness();drag(h);h.end();const complete=h.calls.springs[0].callback;h.start();complete(true);
  h.setTime(40);h.touch('onTouchesMove',90);h.end();assert.equal(h.calls.springs.length,2);
});
test('Android FlatList default clipping and cell identity survive with active recoil',()=>{
  const cells=[{key:'cell-1',type:'CellRenderer'},{key:'cell-2',type:'CellRenderer'}],style={padding:14};
  const h=harness({removeClippedSubviews:true,children:cells,contentContainerStyle:style});drag(h);h.end();
  assert.equal(h.scroll().type,'Animated.ScrollView');assert.equal(h.scroll().props.removeClippedSubviews,true);
  assert.equal(h.content(),cells);assert.equal(h.scroll().props.contentContainerStyle,style);assert.equal(h.calls.springs.length,1);
});
test('late public inner ref becomes ready on layout without replacing or wrapping children',()=>{
  const h=harness(),node=makeNode(),getInner=node.getInnerViewRef;node.getInnerViewRef=()=>null;h.attach(node);h.geometry();h.start();h.setTime(10);h.touch('onTouchesMove',50);h.end();assert.equal(h.calls.springs.length,0);
  node.getInnerViewRef=getInner;h.geometry();h.start();h.setTime(20);h.touch('onTouchesMove',50);h.end();assert.equal(h.calls.springs.length,1);
});
test('tap during recoil holds the presented position and resumes recoil on failed Finalize',()=>{
  const h=harness();drag(h);h.end();const held=h.presentation();h.touch('onTouchesDown');assert.deepEqual(h.presentation(),held);
  h.end(false);assert.deepEqual(h.presentation(),held);assert.equal(h.calls.springs.length,2);
});
test('another recognizer winning releases decoration smoothly without moving native scroll position',()=>{
  const h=harness();drag(h);const held=h.presentation();h.touch('onTouchesCancelled',0,0,0);assert.deepEqual(h.presentation(),held);assert.equal(h.calls.springs.length,1);assert.equal(h.calls.commands.length,0);
});
test('exact RN 0.86.3 public methods and host assignment execute with matching command semantics', ()=>{
  const source=readFileSync(rnSource,'utf8'),commands=[],warnings=[];
  const pick=(name)=>{const start=source.indexOf(`  ${name}: ScrollViewImperativeMethods['${name}'] =`);assert.ok(start>=0);const end=source.indexOf('\n  };',start);return source.slice(source.indexOf('=',start)+1,end+4).trim().replace(/;$/,'');};
  const inner={},instance={_innerView:{nativeInstance:inner},getNativeScrollRef(){return this;}};
  function method(name){return runInNewContext(`(function(){return (${pick(name)});})`,{Commands:{scrollTo:(...a)=>commands.push(['scrollTo',a.slice(1)]),scrollToEnd:(...a)=>commands.push(['scrollToEnd',a.slice(1)])},console:{warn:(...a)=>warnings.push(a)}}).call(instance);}
  instance.scrollTo=method('scrollTo');instance.scrollToEnd=method('scrollToEnd');instance.getInnerViewRef=method('getInnerViewRef');
  const start=source.indexOf('Object.assign(\n        nativeInstance,'),end=source.indexOf('\n      );',start);
  const assign=runInNewContext(`(function(nativeInstance){return ${source.slice(start,end+8).replace(/;$/,'')};})`);
  const host=assign.call(instance,{});assert.equal(host.getInnerViewRef(),inner);assert.equal(Object.getOwnPropertyDescriptor(host,'scrollTo').writable,true);
  const h=harness(),node=h.attach();
  const options=[[],[{x:14,y:27,animated:false}],[40,20,false],[{y:0}],[{x:NaN,y:NaN}]];
  for(const args of options){host.scrollTo(...args);node.scrollTo(...args);}host.scrollToEnd();node.scrollToEnd();
  assert.deepEqual(plain(commands),h.calls.commands.map(c=>[c.name,c.args]));assert.deepEqual(plain(warnings),plain(h.calls.warnings));
});
test('RTL horizontal offsets remain physical: x=0 left edge and x=range right edge',()=>{
  for(const [nativeOffset,pointer,sign]of [[0,50,1],[400,-50,-1]]){
    const h=harness({horizontal:true,rtl:true});h.attach();h.geometry();h.motion(nativeOffset,1);h.start();h.setTime(20);h.touch('onTouchesMove',pointer);h.end();
    assert.equal(Math.sign(h.presentation().translateX),sign);assert.equal(h.calls.springs.length,1);
  }
});
test('invalid geometry cannot start a spring or produce non-finite release velocity',()=>{
  for(const [viewport,content]of [[0,600],[NaN,600],[Infinity,600],[200,NaN],[200,Infinity]]){
    const h=harness();h.attach();h.geometry(viewport,content);h.start();h.setTime(10);h.touch('onTouchesMove',90);h.end();assert.equal(h.calls.springs.length,0);
  }
});
test('a previous touch owner cannot overwrite or reset presentation after another view acquires it',()=>{
  const h=harness(),shared=h.mutable(0);h.render({springOffset:shared});drag(h);
  const peer=h.peer({springOffset:shared});peer.attach();peer.scroll.props.onLayout({nativeEvent:{layout:{width:200,height:200}}});peer.scroll.props.onContentSizeChange(600,600);
  peer.gesture.handlers.onTouchesDown({numberOfTouches:1,allTouches:[{absoluteX:0,absoluteY:0}]});peer.gesture.handlers.onStart({});
  shared.value=10;h.setTime(30);h.touch('onTouchesMove',90);assert.equal(shared.value,10);h.unmount();assert.equal(shared.value,10);peer.unmount();
});
test('an existing Native which activates before first touch data still acquires the actual drag',()=>{
  const h=harness();h.attach();h.geometry();h.gesture().handlers.onStart({});h.touch('onTouchesDown');h.setTime(20);h.touch('onTouchesMove',50);h.end();assert.equal(h.calls.springs.length,1);
});
test('callback binding/replay never overwrites GestureDetector runtime handler metadata',()=>{
  const h=harness();assert.equal(h.gesture().handlers.handlerTag,777);h.gesture().handlers.handlerTag=888;h.replay();assert.equal(h.gesture().handlers.handlerTag,888);h.unmount();assert.equal(h.gesture().handlers.handlerTag,888);
});
test('gesture context exports ancestor and own Native identities through React-only providers',()=>{
  const cells=[{type:'CellRenderer',key:'cell'}],h=harness({children:cells});
  const context=h.exports.SpringScrollGestureContext;assert.ok(context);assert.deepEqual(plain(context.value),[]);
  const own=h.gesture(),provided=h.provided();assert.equal(provided.type,context.Provider);assert.equal(provided.props.children,cells);
  assert.equal(provided.props.value.length,1);assert.equal(provided.props.value[0],own);
  const child=h.peer({children:cells},provided.props.value);assert.equal(child.provided.type,context.Provider);
  assert.equal(child.provided.props.value.length,2);assert.equal(child.provided.props.value[0],own);assert.equal(child.provided.props.value[1],child.gesture);assert.equal(child.provided.props.children,cells);
  const grandchild=h.peer({},child.provided.props.value);assert.equal(grandchild.provided.props.value.length,3);
  assert.equal(grandchild.provided.props.value[0],own);assert.equal(grandchild.provided.props.value[1],child.gesture);assert.equal(grandchild.provided.props.value[2],grandchild.gesture);
  assert.equal(h.calls.native,3);assert.equal(h.calls.pan,0);
});
test('own Native and provided ancestor array remain stable across callback reconfiguration and replay',()=>{
  const h=harness(),own=h.gesture(),provided=h.provided();
  h.render({horizontal:true,onScroll:()=>{},children:'new content'});assert.equal(h.gesture(),own);assert.equal(h.provided().props.value,provided.props.value);
  h.replay();assert.equal(h.gesture(),own);assert.equal(h.calls.native,1);assert.equal(h.calls.pan,0);
});
test('caller-supplied Native is retained for the lifetime and is exposed to descendants',()=>{
  const factory=harness(),supplied=factory.nativeGesture();const h=harness({nativeGesture:supplied});
  assert.equal(h.gesture(),supplied);assert.equal(h.provided().props.value[0],supplied);
  h.render({nativeGesture:supplied,horizontal:true});assert.equal(h.gesture(),supplied);assert.equal(h.calls.native,0);
});
test('responder leaf commands invalidate owned flings and restore both public surfaces',()=>{
  const node=makeNode(),responder=makeNode();responder.getNativeScrollRef=()=>node;node.getScrollResponder=()=>responder;
  const originalHost=Object.getOwnPropertyDescriptors(node),originalResponder=Object.getOwnPropertyDescriptors(responder);
  const h=harness();h.attach(node);h.geometry();h.motion(100,1);h.start();h.motion(200,10);h.end();
  responder.scrollTo({y:350,animated:true});h.motion(350,20);h.motion(400,30);assert.equal(h.calls.springs.length,0);
  responder.scrollToEnd({animated:false});assert.deepEqual(h.calls.commands.map(c=>[c.name,c.args]),[['scrollTo',[0,350,true]],['scrollToEnd',[false]]]);
  const oldLeaf=responder.scrollTo;h.unmount();assert.deepEqual(Object.getOwnPropertyDescriptors(node),originalHost);assert.deepEqual(Object.getOwnPropertyDescriptors(responder),originalResponder);
  oldLeaf({y:90});assert.equal(h.calls.commands.length,2);
});
test('nonwritable responder leaf leaves both surfaces untouched and disables decorative recoil',()=>{
  const node=makeNode(),responder=makeNode();node.getScrollResponder=()=>responder;Object.defineProperty(responder,'scrollTo',{writable:false});
  const original=node.scrollTo,h=harness();h.attach(node);h.geometry();h.start();h.setTime(20);h.touch('onTouchesMove',50);h.end();assert.equal(node.scrollTo,original);assert.equal(h.calls.springs.length,0);
});
test('exact RN keyboard measurement routine reaches the intercepted responder leaf during a fling', ()=>{
  const source=readFileSync(rnSource,'utf8'),start=source.indexOf('  _inputMeasureAndScrollToKeyboard: ('),body=source.indexOf(') => void = ',start)+') => void = '.length,end=source.indexOf('\n  };',body);
  assert.ok(start>=0&&end>body);const expression=source.slice(body,end+4).trim().replace(/;$/,'');
  const code=ts.transpileModule(`exports.factory=function(){return (${expression});};`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  for(const deferred of [false,true]){
    const exports={},timers=[];runInNewContext(code,{exports,Dimensions:{get:()=>({height:800})},setTimeout:fn=>timers.push(fn)});
    const node=makeNode(),responder=makeNode();responder.getNativeScrollRef=()=>node;node.getScrollResponder=()=>responder;
    responder._keyboardMetrics=deferred?null:{screenY:500};responder._additionalScrollOffset=10;responder._preventNegativeScrollOffset=true;
    const measure=exports.factory.call(responder),callbackCalls=[];
    const h=harness({onScroll:()=>callbackCalls.push('scroll'),onScrollEndDrag:()=>callbackCalls.push('end')});h.attach(node);h.geometry();h.motion(100,1);h.start();h.motion(200,10);h.end();
    measure(0,700,100,60);if(deferred){assert.equal(h.calls.commands.length,0);responder._keyboardMetrics={screenY:500};timers.shift()();}
    assert.deepEqual(h.calls.commands.map(c=>[c.name,c.args]),[['scrollTo',[0,270,true]]]);
    assert.equal(responder._additionalScrollOffset,0);assert.equal(responder._preventNegativeScrollOffset,false);
    h.motion(350,20);h.motion(400,30);assert.equal(h.calls.springs.length,0);assert.deepEqual(callbackCalls,[]);
  }
});

test('saved scrollTo survives repeated layout-effect replay and still invalidates flings on UI',()=>{
  const h=harness(),node=h.attach(),saved=node.scrollTo;
  saved({y:50});assert.equal(h.calls.commands.length,1);
  for(let i=0;i<3;i++){
    h.replay();h.geometry();h.motion(100,1);h.start();h.motion(200,10);h.end();
    h.defer();saved({y:350,animated:false});
    assert.equal(h.calls.commands.length,i+1,'dispatch waits for the UI job');
    h.flush();h.defer(false);
    assert.equal(h.calls.commands.length,i+2,'saved method dispatches after replay');
    assert.equal(h.calls.commands.at(-1).node,node);
    assert.deepEqual(h.calls.commands.at(-1).args,[0,350,false]);
    h.motion(350,20);h.motion(400,30);assert.equal(h.calls.springs.length,0,'command revokes owned fling');
  }
});

test('saved scrollToEnd survives callback-ref rebinding and same-host detach/reattach',()=>{
  const h=harness({ref:()=>{}}),node=h.attach(),saved=node.scrollToEnd,oldRef=h.scroll().props.ref;
  saved();oldRef(null);h.render({ref:()=>{}});h.attach(node);
  saved({animated:false});
  assert.deepEqual(h.calls.commands.map(c=>[c.name,c.args]),[['scrollToEnd',[true]],['scrollToEnd',[false]]]);
  h.scroll().props.ref(null);h.attach(node);saved();
  assert.equal(h.calls.commands.length,3);assert.equal(h.calls.commands.at(-1).node,node);
});

test('saved legacy keyboard responder leaves survive replay and same-host reattachment',()=>{
  const node=makeNode(),responder=makeNode();responder.getNativeScrollRef=()=>node;node.getScrollResponder=()=>responder;
  const originals=[Object.getOwnPropertyDescriptors(node),Object.getOwnPropertyDescriptors(responder)];
  const h=harness();h.attach(node);const keyboardScroll=responder.scrollTo,end=responder.scrollToEnd;
  keyboardScroll({y:270});h.replay();keyboardScroll({y:280});
  h.scroll().props.ref(null);h.attach(node);h.geometry();h.motion(100,1);h.start();h.motion(200,10);h.end();
  end({animated:false});h.motion(350,20);h.motion(400,30);
  assert.deepEqual(h.calls.commands.map(c=>[c.name,c.args]),[['scrollTo',[0,270,true]],['scrollTo',[0,280,true]],['scrollToEnd',[false]]]);
  assert.equal(h.calls.springs.length,0);h.unmount();
  assert.deepEqual(Object.getOwnPropertyDescriptors(node),originals[0]);assert.deepEqual(Object.getOwnPropertyDescriptors(responder),originals[1]);
});

test('retired numeric scrollTo delegates before normalization and warns exactly once',()=>{
  const h=harness(),node=h.attach(),saved=node.scrollTo;h.replay();h.replay();saved(25,10,false);
  assert.equal(h.calls.warnings.length,1);assert.equal(h.calls.commands.length,1);
  assert.deepEqual(h.calls.commands[0].args,[10,25,false]);
});

test('retired leaves use current methods, preserve target receiver, and fall back without self-recursion',()=>{
  for(const name of ['scrollTo','scrollToEnd'])for(const current of ['replacement','self','missing']){
    const h=harness(),node=makeNode(),seen=[],args=name==='scrollTo'?[{y:31}]:[{animated:false}];
    const original=function(...received){seen.push({receiver:this,received,kind:'original'});return 17;};
    Object.defineProperty(node,name,{value:original,writable:true,configurable:true,enumerable:false});
    const descriptor=Object.getOwnPropertyDescriptor(node,name);h.attach(node);const saved=node[name];h.unmount();
    assert.deepEqual(Object.getOwnPropertyDescriptor(node,name),descriptor);
    if(current==='replacement')node[name]=function(...received){seen.push({receiver:this,received,kind:'replacement'});return 17;};
    else if(current==='self')node[name]=saved;
    else delete node[name];
    assert.equal(saved(...args),17);assert.equal(seen.length,1);assert.equal(seen[0].receiver,node);
    assert.deepEqual(seen[0].received,args);assert.equal(seen[0].kind,current==='replacement'?'replacement':'original');
    assert.equal(h.calls.commands.length,0);
  }
});

test('failed partial interception retires escaped wrapper and restores original descriptors',()=>{
  const h=harness(),base=makeNode(),seen=[];let escaped;
  base.scrollTo=function(...args){seen.push({receiver:this,args});};
  const original=Object.getOwnPropertyDescriptors(base);
  const node=new Proxy(base,{defineProperty(target,key,descriptor){
    if(key==='scrollToEnd')throw Error('cannot install end leaf');
    if(key==='scrollTo'&&descriptor.value!==original.scrollTo.value)escaped=descriptor.value;
    return Reflect.defineProperty(target,key,descriptor);
  }});
  h.attach(node);assert.deepEqual(Object.getOwnPropertyDescriptors(base),original);assert.equal(typeof escaped,'function');
  escaped({y:77});assert.equal(seen.length,1);assert.equal(seen[0].receiver,node);assert.deepEqual(seen[0].args,[{y:77}]);
  h.geometry();h.start();h.setTime(20);h.touch('onTouchesMove',50);h.end();assert.equal(h.calls.springs.length,0);
});

test('saved leaves retain exact RN native-null checks after true unmount', ()=>{
  const source=readFileSync(rnSource,'utf8'),nativeCalls=[],warnings=[];
  const node=makeNode();let native=node;
  const instance={getNativeScrollRef:()=>native};
  for(const name of ['scrollTo','scrollToEnd']){
    const start=source.indexOf(`  ${name}: ScrollViewImperativeMethods['${name}'] =`),end=source.indexOf('\n  };',start);
    assert.ok(start>=0&&end>start);
    const expression=source.slice(source.indexOf('=',start)+1,end+4).trim().replace(/;$/,'');
    node[name]=runInNewContext(`(function(){return (${expression});})`,{
      Commands:{scrollTo:(...args)=>nativeCalls.push(args),scrollToEnd:(...args)=>nativeCalls.push(args)},
      console:{warn:(...args)=>warnings.push(args)},
    }).call(instance);
  }
  const originals=Object.getOwnPropertyDescriptors(node),h=harness();h.attach(node);
  const to=node.scrollTo,end=node.scrollToEnd;h.unmount();
  to({y:2});end();assert.equal(nativeCalls.length,2,'original leaves remain callable while native ref exists');
  native=null;to(3,4,false);end({animated:false});
  assert.equal(nativeCalls.length,2);assert.equal(warnings.length,1);assert.equal(h.calls.warnings.length,0);
  assert.equal(h.calls.commands.length,0);assert.deepEqual(Object.getOwnPropertyDescriptors(node),originals);
});

test('queued saved-method commands cannot cross replay, same-host reattach, or replacement epochs',()=>{
  for(const transition of ['replay','same','replacement']){
    const h=harness(),first=h.attach(),saved=first.scrollTo;h.replay();
    h.defer();saved({y:88});assert.equal(h.jobs.length,1);const stale=h.jobs.shift();
    if(transition==='replay')h.replay();else {h.scroll().props.ref(null);h.attach(transition==='same'?first:makeNode());}
    h.flush();stale();assert.equal(h.calls.commands.length,0);
    h.defer(false);h.node.scrollTo({y:99});assert.equal(h.calls.commands.length,1);assert.equal(h.calls.commands[0].node,h.node);
  }
});

test('changing scroll axis retains the Native identity and moves presentation onto the new axis',()=>{
  const h=harness();drag(h);h.end();const native=h.gesture();
  h.render({horizontal:true});h.geometry();
  assert.equal(h.gesture(),native);assert.deepEqual(plain(h.presentation()),{translateX:0});
  h.start();h.setTime(40);h.touch('onTouchesMove',60);h.end();
  assert.ok(h.presentation().translateX>0);assert.equal(h.presentation().translateY,undefined);
  assert.equal(h.calls.springs.length,2);
});
