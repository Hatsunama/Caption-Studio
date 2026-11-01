import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
const repo = fileURLToPath(new URL('../', import.meta.url));
const root = path.resolve(process.env.REANIMATED_SOURCE_ROOT ?? path.join(repo, 'node_modules/react-native-reanimated'));
const base = path.dirname(path.dirname(root));
// Pinned RNGH source sits alongside the audited engine. No native renderer,
// timer, JSI, serialization or age-GC behavior is claimed by this JS fixture.
const auditedRngh = path.join(base, 'type-sources/node_modules/react-native-gesture-handler');
const rnghRoot = process.env.RNGH_SOURCE_ROOT ?? (fs.existsSync(auditedRngh) ? auditedRngh : path.join(repo, 'node_modules/react-native-gesture-handler'));
const rnghSource = path.join(rnghRoot, 'src/handlers/gestures/GestureDetector/Wrap.tsx');
function run(mode) {
assert.equal(JSON.parse(fs.readFileSync(path.join(root,'package.json'))).version,'4.5.1');
assert.equal(JSON.parse(fs.readFileSync(path.join(rnghRoot,'package.json'))).version,'2.32.0');
function load(file, imports, globals = {}) {
  const filename = path.isAbsolute(file) ? file : path.join(root, file);
  const source = fs.readFileSync(filename, 'utf8');
  const result = ts.transpileModule(source, {fileName: filename, reportDiagnostics: true,
    compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX}});
  assert.equal(result.diagnostics?.length ?? 0, 0, `Syntax diagnostics: ${filename}`);
  const module = {exports: {}};
  const context = vm.createContext({module, exports: module.exports, require(id) {
    assert.ok(Object.hasOwn(imports, id), `Unexpected import ${id} in ${file}`);
    return imports[id];
  }, __DEV__: false, ...globals});
  context.global = context;
  vm.runInContext(result.outputText, context, {filename});
  return module.exports;
}

// Deliberately small hook scheduler. Layout order is supplied by the harness,
// NOT evidence of actual React/Fabric commit order.
let active;
const sameDeps = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
const react = {
  Component: class {
    constructor(props) { this.props = props; }
    setState(updater) { this.state = {...this.state, ...updater(this.state)}; }
  },
  Fragment: 'Fragment',
  forwardRef: render => ({render}),
  useRef(value) { const i = active.index++; return active.slots[i] ??= {current: value}; },
  useState(value) {
    const instance = active, i = instance.index++;
    const slot = instance.slots[i] ??= {value: typeof value === 'function' ? value() : value};
    return [slot.value, updater => {
      const next=typeof updater === 'function' ? updater(slot.value) : updater;
      if(!Object.is(next,slot.value)){slot.value=next;instance.dirty=true;}
    }];
  },
  useMemo(factory, deps) {
    const i = active.index++, previous = active.slots[i];
    if (!previous || !sameDeps(previous.deps, deps)) active.slots[i] = {value: factory(), deps};
    return active.slots[i].value;
  },
  useCallback(callback, deps) { return react.useMemo(() => callback, deps); },
  useImperativeHandle(ref, factory, deps) {
    const instance = active, i = instance.index++, previous = instance.slots[i];
    if (!previous || !sameDeps(previous.deps, deps) || previous.ref !== ref) {
      const slot = instance.slots[i] = {deps, ref, cleanup: previous?.cleanup};
      instance.effects.push(() => {
        slot.cleanup?.();
        const handle = factory();
        if (typeof ref === 'function') {
          const cleanup = ref(handle);
          slot.cleanup = typeof cleanup === 'function' ? cleanup : () => { ref(null); };
        } else if (ref) {
          ref.current = handle;
          slot.cleanup = () => { ref.current = null; };
        }
      });
    }
  },
};
react.default = react;
const jsx = {jsx: (type, props, key) => ({type, props, key}), jsxs: (type, props, key) => ({type, props, key})};
const flatten = style => {
  if (!style) return {};
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
  return style;
};
const NativeScrollView = function NativeScrollView() {};
const rn = {ScrollView: NativeScrollView, Platform: {select: props => props.default}, StyleSheet: {flatten}};
const calls = {mark: [], unmark: [], intervals: [], cleared: [], update: [], css: [], descriptors: []};
const common = {SHOULD_BE_USE_WEB: false, IS_ANDROID: true, IS_WEB: false, IS_JEST: false, processColorsInProps() {}, logger: {warn: assert.fail}};
const host = tag => ({__nativeTag: tag, __viewConfig: {uiViewClassName: 'RCTView'},
  __internalInstanceHandle: {stateNode: {node: {tag, family: `family-${tag}`}}}});
const inner = host(228), outer = host(226);
let actualInner = inner;
outer.getInnerViewRef = () => actualInner;
const findHost = load('src/platform-specific/findHostInstance.ts', {});
const viewInfo = load('src/createAnimatedComponent/getViewInfo.ts', {});
const fabric = load('src/fabricUtils.ts', {'./platform-specific/findHostInstance': findHost});
const cssUtils = load('src/css/component/utils.ts', {'../utils/guards': {
  isCSSConfigProp: key => key.startsWith('transition') || key.startsWith('animation'), isPseudoSelectorValue: () => false,
}});
const css = load('src/css/component/AnimatedComponent.tsx', {
  react, 'react/jsx-runtime': jsx, 'react-native': rn, '../../common': common,
  '../../createAnimatedComponent/getViewInfo': viewInfo, '../../fabricUtils': fabric,
  '../../platform-specific/findHostInstance': findHost,
  '../native': {markNodeAsRemovable: node => calls.mark.push(node), unmarkNodeAsRemovable: tag => calls.unmark.push(tag)},
  '../platform': {CSSManager: class { constructor(info) { this.info = info; } update(style) { calls.css.push(style); } unmountCleanup() {} }},
  './utils': cssUtils,
});
let settled = [];
const gc = load('src/PropsRegistryGarbageCollector.ts', {
  './common/style/processors/colors': {unprocessColor: x => x, unprocessColorsInProps() {}},
  './ReanimatedModule': {ReanimatedModule: {getSettledUpdates: () => settled}},
}, {setInterval(fn, ms) { calls.intervals.push({fn, ms}); return calls.intervals.length; }, clearInterval: id => calls.cleared.push(id)}).PropsRegistryGarbageCollector;
const utils = load('src/createAnimatedComponent/utils.ts', {});
const inline = {InlinePropManager: class {attachInlineProps() {} detachInlineProps() {}},
  hasInlineStyles: () => false, getInlineStyle: assert.fail};
const filter = load('src/createAnimatedComponent/PropsFilter.tsx', {
  '../animation': {initialUpdaterRun: fn => fn()}, '../css/utils': {isCSSConfigProp: () => false},
  '../isSharedValue': {isSharedValue: () => false}, '../WorkletEventHandler': {WorkletEventHandler: class {}},
  './InlinePropManager': inline, './utils': utils,
});
const impl = load('src/createAnimatedComponent/AnimatedComponent.tsx', {
  '../layoutReanimation/animationsManager': {}, react, 'react/jsx-runtime': jsx,
  '../animationBuilder': {checkStyleOverwriting() {}, maybeBuild: x => x}, '../common': common,
  '../commonTypes': {LayoutAnimationType: {ENTERING: 1, EXITING: 2, LAYOUT: 3}},
  '../component/LayoutAnimationConfig': {SkipEnteringContext: {}},
  '../css/component/AnimatedComponent': css,
  '../featureFlags': {getStaticFeatureFlag: key => key === 'FORCE_REACT_RENDER_FOR_SETTLED_ANIMATIONS'},
  '../layoutReanimation/SharedTransition': {SharedTransition: class {}},
  '../layoutReanimation/web': {}, '../layoutReanimation/web/domUtils': {},
  '../PropsRegistryGarbageCollector': {PropsRegistryGarbageCollector: gc},
  '../UpdateLayoutAnimations': {updateLayoutAnimations() {}}, './InlinePropManager': inline,
  './JSPropsUpdater': {default: {}}, './NativeEventsManager': {NativeEventsManager: class {attachEvents() {} detachEvents() {} updateEvents() {}}},
  './PropsFilter': filter, './utils': utils,
});
const factory = load('src/createAnimatedComponent/createAnimatedComponent.tsx', {
  'react/jsx-runtime': jsx, './AnimatedComponent': impl,
});
function scope() { return {slots: [], index: 0, effects: [], dirty: false}; }
function render(scope, component, props, ref) {
  active = scope; scope.index = 0; scope.effects = []; scope.dirty = false;
  try { return component.render(props, ref); } finally { active = null; }
}
function layout(scope) { for (const effect of scope.effects.splice(0)) effect(); }
function cleanup(scope) { for (const slot of scope.slots) { slot?.cleanup?.(); if (slot) slot.cleanup = undefined; } }

if (mode === 'duplicate') {
  const animated = factory.createAnimatedComponent(NativeScrollView);
  const instances = [0,1].map(() => {
    const element = animated({style:{}}), instance = new element.type(element.props);
    instance.render().props.ref(outer); instance.componentDidMount(); return instance;
  });
  assert.equal(gc.viewsCount, 1, 'pinned register skips the duplicate outer tag');
  assert.equal(gc.viewsMap.get(226), instances[0]);
  settled = [{viewTag:228,styleProps:{transform:[{translateY:9}]}}];
  gc.syncPropsBackToReact();
  assert.equal(instances[0].state.settledProps.transform, undefined, 'unowned inner has no GC synchronization');
  instances.forEach(instance => instance.componentWillUnmount());
  assert.equal(gc.viewsCount, -1, 'pinned unregister decrements for both owners');
  assert.equal(gc.viewsMap.size, 0);
  assert.ok(calls.mark.every(node => node === outer.__internalInstanceHandle.stateNode.node));
  return;
}

react.useLayoutEffect = (fn,deps) => {
  const instance=active,i=instance.index++,previous=instance.slots[i];
  if(!previous||!sameDeps(previous.deps,deps)){
    const slot=instance.slots[i]={deps,cleanup:previous?.cleanup};
    instance.effects.push(()=>{slot.cleanup?.();slot.cleanup=fn();});
  }
};
const candidate = load(path.join(repo,'src/components/spring-scroll-content.tsx'), {
  react,'react/jsx-runtime':jsx,'react-native':rn,
  'react-native-reanimated':{__esModule:true,default:{createAnimatedComponent:factory.createAnimatedComponent}},
});
function mountOwner(element) {
  const classElement=element.type(element.props),owner=new classElement.type(classElement.props),hooks=scope();
  function update(){const target=owner.render();assert.equal(render(hooks,target.type,target.props,target.props.ref),null);layout(hooks);}
  update();owner.componentDidMount();
  return {owner,update,unmount(){owner.componentWillUnmount();cleanup(hooks);}};
}
if(mode==='adapter'){
  let serialized;
  active=scope();
  const refHook=load('src/hook/useAnimatedRef.ts',{
    react,'react-native-worklets':{createSerializable:value=>{serialized=value;return value;},serializableMappingCache:new WeakMap()},
    '../common/constants':common,'../fabricUtils':fabric,'../mutables':{makeMutable:value=>({value})},
    '../platformFunctions/findNodeHandle':{findNodeHandle:ref=>ref.__nativeTag},
  });
  const ref=refHook.useAnimatedRef();active=null;
  const nativeProps=load('src/platformFunctions/setNativeProps.ts',{
    'react-native-worklets':{RuntimeKind:{ReactNative:1}},'../common':common,
    '../featureFlags':{getStaticFeatureFlag:()=>false},
  },{__RUNTIME_KIND:2,_updateProps:ops=>calls.update.push(...ops),_maybeFlushUIUpdatesQueue(){}});
  const styles=[];
  const mounted=mountOwner({type:candidate.ScrollContentOwner,props:{host:inner,onStyle:style=>styles.push(style),ref}});
  assert.equal(ref.current,inner);assert.equal(findHost.findHostInstance(mounted.owner),inner);
  assert.equal(mounted.owner._getViewInfo().shadowNodeWrapper,inner.__internalInstanceHandle.stateNode.node);
  assert.equal(gc.viewsMap.get(228),mounted.owner);assert.equal(gc.viewsCount,1);
  assert.equal(mounted.owner._animatedStyles.length,0,'no artificial animated-style handle');
  assert.equal(styles.at(-1),undefined,'initial owner style is empty');assert.equal(calls.intervals[0].ms,500);
  nativeProps.setNativeProps(serialized.__init(),{transform:[{translateY:7}]});
  assert.equal(calls.update[0].shadowNodeWrapper,mounted.owner._getViewInfo().shadowNodeWrapper);
  settled=[{viewTag:228,styleProps:{transform:[{translateY:7}],opacity:0.4,pointerEvents:'none'}}];
  calls.intervals[0].fn();mounted.update();mounted.owner.componentDidUpdate(mounted.owner.props,{},null);
  assert.equal(styles.at(-1).transform[0].translateY,7);assert.equal(styles.at(-1).opacity,0.4);
  assert.equal(styles.at(-1).pointerEvents,'none');
  mounted.unmount();assert.equal(gc.viewsCount,0);assert.equal(gc.viewsMap.size,0);
  assert.equal(calls.mark.at(-1),inner.__internalInstanceHandle.stateNode.node);
  const replay=mountOwner({type:candidate.ScrollContentOwner,props:{host:inner,onStyle:()=>{},ref}});
  assert.equal(gc.viewsMap.get(228),replay.owner);replay.unmount();assert.equal(gc.viewsCount,0);
  assert.equal(candidate.sameContentStyle(undefined,undefined),true);
  assert.equal(candidate.sameContentStyle(undefined,{}),false);
  const transform=[{translateY:7}];assert.equal(candidate.sameContentStyle({transform},{transform}),true);
  assert.equal(candidate.sameContentStyle({opacity:1},{opacity:2}),false);
  assert.equal(candidate.sameContentStyle({opacity:1},{opacity:1,width:2}),false);
  return;
}
Object.assign(react,{createContext:value=>({value,Provider:'Provider'}),useContext:context=>context.value,useEffect:react.useLayoutEffect});
rn.Platform.OS='android';rn.AppState={currentState:'active',addEventListener:()=>({remove(){}})};
rn.AccessibilityInfo={addEventListener:()=>({remove(){}}),isReduceMotionEnabled:()=>({then(){}})};
let binding,mounted,ownerElement,tree;
const sourceScope=scope(),ready=[];
const animated={createAnimatedComponent:factory.createAnimatedComponent};
const reanimated={__esModule:true,default:animated,useSharedValue:value=>react.useRef({value}).current,
  useReducedMotion:()=>false,useScrollOffset(){},useAnimatedReaction(){},
  useAnimatedRef:()=>react.useMemo(()=>{const ref=value=>{if(value)ref.current=value;return ref.current;};ref.current=null;return ref;},[])};
const nativeGesture=()=>{const g={handlers:{isWorklet:[]},config:{}};g.disallowInterruption=g.shouldCancelWhenOutside=()=>g;return g;};
const imports={react,'react/jsx-runtime':jsx,'react-native':rn,'react-native-reanimated':reanimated,
  'react-native-worklets':{scheduleOnUI:(fn,...args)=>fn(...args)},
  'react-native-gesture-handler':{Gesture:{Native:nativeGesture},GestureDetector:'GestureDetector'},
  '../lib/scroll-spring-policy':{createScrollSpringAxisState:()=>({})},
  './spring-scroll-content':candidate,'./spring-scroll-gesture':{interceptSpringScrollCommands:()=>()=>{}},
  './scroll-spring-controller':{createScrollSpringController:options=>{
    binding=options;return new Proxy({gesture:options.gesture,contentReady(){
      assert.ok(mounted,'contentReady follows actual child owner mount');assert.equal(gc.viewsMap.get(actualInner.__nativeTag),mounted.owner);ready.push(actualInner);
    }},{get:(o,k)=>o[k]??(()=>{})});
  }},
};
const app=load(path.join(repo,'src/components/spring-scroll-view.tsx'),imports);
const children=[{key:'cell-1'},{key:'cell-2'}],baseStyle={padding:9},outerStyle={flex:1},publicRef={current:null};
const props={children,style:outerStyle,contentContainerStyle:baseStyle,ref:publicRef,
  keyboardShouldPersistTaps:'handled',keyboardDismissMode:'on-drag',pointerEvents:'auto',horizontal:false,testID:'native',nativeID:'caller',scrollViewRef:{current:null},innerViewRef:{current:null}};
function commit(){let turns=0;do{
  assert.ok(++turns<30,'source state/style feedback settles');active=sourceScope;sourceScope.index=0;sourceScope.effects=[];sourceScope.dirty=false;
  try{tree=app.SpringScrollView(props);while(typeof tree.type==='function')tree=tree.type(tree.props);}finally{active=null;}
  assert.equal(tree.type,react.Fragment);const next=tree.props.children.find(child=>child?.type!=='GestureDetector')??null;
  if(ownerElement?.key!==next?.key){mounted?.unmount();mounted=undefined;}
  ownerElement=next;
  if(next){if(!mounted)mounted=mountOwner(next);else{mounted.owner.props=next.props;mounted.update();}}
  layout(sourceScope);
}while(sourceScope.dirty);}
const leaf=()=>tree.props.children.find(child=>child?.type==='GestureDetector').props.children;
actualInner=null;commit();assert.equal(ownerElement,null,'absent host has no owner');
const native=leaf();assert.equal(native.type,NativeScrollView);native.props.ref(outer);commit();
assert.equal(ownerElement,null,'attached outer with missing inner never runs a throwing fabricated owner');
assert.equal(binding.getAnimatedRef().current,outer);assert.equal(publicRef.current,outer);
actualInner=inner;native.props.onLayout({nativeEvent:{layout:{width:200,height:200}}});commit();
assert.equal(binding.getContentRef().current,inner);assert.equal(mounted.owner.getComponentViewTag(),228);
assert.equal(leaf().type,native.type);assert.equal(leaf().props.ref,native.props.ref);assert.equal(leaf().key,undefined);
assert.equal(leaf().props.children.props.children,children);assert.equal(leaf().props.style,outerStyle);
assert.equal(leaf().props.contentContainerStyle,baseStyle);
for(const key of ['keyboardShouldPersistTaps','keyboardDismissMode','pointerEvents','horizontal','testID','nativeID','innerViewRef','scrollViewRef'])assert.equal(leaf().props[key],props[key]);
// Execute actual RNGH Wrap/factory/class against explicit native metadata.
react.Children={only:value=>value};react.cloneElement=(child,extra,children)=>({...child,props:{...child.props,...extra,children}});
const wrap=load(rnghSource,{react,'../reanimatedWrapper':{Reanimated:{default:animated}},'../../../utils':{tagMessage:x=>x}});
const wrapped=wrap.AnimatedWrap({children:leaf()}),detector=new wrapped.type(wrapped.props);
const wrapLeaf=detector.render(),wrapInstance=new wrapLeaf.type(wrapLeaf.props);
assert.equal(wrapInstance.render().props.collapsable,false);Object.assign(wrapInstance,outer);
wrapLeaf.props.ref(wrapInstance);detector.componentDidMount();
assert.equal(gc.viewsCount,2);assert.deepEqual([...gc.viewsMap.keys()],[228,226]);
const old=mounted.owner,oldKey=ownerElement.key,oldCallback=ownerElement.props.onStyle;
settled=[{viewTag:228,styleProps:{transform:[{translateY:17}],opacity:0.4,pointerEvents:'none'}}];gc.syncPropsBackToReact();mounted.update();commit();
assert.equal(flatten(leaf().props.contentContainerStyle).transform[0].translateY,17);
assert.equal(leaf().props.pointerEvents,'auto');assert.equal(leaf().props.transform,undefined);assert.equal(leaf().props.opacity,undefined);
const replacement=host(328);actualInner=replacement;leaf().props.onContentSizeChange(600,600);commit();
assert.notEqual(ownerElement.key,oldKey);assert.notEqual(mounted.owner,old);
assert.equal(gc.viewsMap.has(228),false);assert.equal(gc.viewsMap.get(328),mounted.owner);assert.equal(gc.viewsCount,2);
assert.equal(calls.mark.at(-1),inner.__internalInstanceHandle.stateNode.node);
assert.equal(leaf().type,native.type);assert.equal(leaf().props.ref,native.props.ref);assert.equal(leaf().props.children.props.children,children);
assert.equal(binding.getAnimatedRef().current,outer);assert.equal(binding.getContentRef().current,replacement);
oldCallback({transform:[{translateY:99}]});commit();assert.equal(leaf().props.contentContainerStyle,baseStyle);
settled=[{viewTag:328,styleProps:{transform:[{translateY:23}]}}];gc.syncPropsBackToReact();mounted.update();commit();
assert.equal(flatten(leaf().props.contentContainerStyle).transform[0].translateY,23);
mounted.unmount();mounted=undefined;assert.equal(gc.viewsMap.has(328),false);native.props.ref(null);detector.componentWillUnmount();
assert.equal(publicRef.current,null);
assert.equal(gc.viewsCount,0);assert.equal(gc.viewsMap.size,0);assert.ok(ready.length>=2);
console.log('headless production ownership',JSON.stringify({old:228,replacement:328,outer:226,finalCount:gc.viewsCount}));
}

test('actual source keyed headless owner retires old GC family while native leaf remains stable',()=>run('production'));
test('public headless owner executes pinned class, collector, AnimatedRef, settled style and lifecycle',()=>run('adapter'));
test('retained pinned-library negative: duplicate outer registration skips once but unregister decrements twice',()=>run('duplicate'));
