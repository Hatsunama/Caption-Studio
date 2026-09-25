import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

import { createCaptionProject } from '../src/lib/project-factory.ts';
import { resolveEditorBackStep } from '../src/lib/editor-back-navigation.ts';
import { createEditorSession } from '../src/services/editor-session.ts';

// Like editor-coordinator.test.mjs, execute the production workspace with native
// adapters. Discover the navigation owner structurally, without capturing named
// setters, matching handler spelling, or implementing a second Back reducer.
const requireLocal = createRequire(import.meta.url);
const source = readFileSync(process.env.CAPTION_EDITOR_SOURCE
  ?? new URL('../src/app/editor.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('editor.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function ownsRemoval(node) {
  if (ts.isStringLiteral(node) && node.text === 'beforeRemove') return true;
  return ts.forEachChild(node, ownsRemoval) === true;
}
const owners = ast.statements.filter((node) => ts.isFunctionDeclaration(node)
  && node.body && ownsRemoval(node));
assert.equal(owners.length, 1, 'find the workspace that owns navigation removal');
const compile = (text) => ts.transpileModule(text, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  fileName: 'editor.tsx',
}).outputText;
const compiled = compile(source + '\nexports.Workspace = ' + owners[0].name.text + ';');
const plain = (value) => JSON.parse(JSON.stringify(value));

function fixture(translated = true) {
  const project = createCaptionProject({
    id: 'back-navigation', name: 'Back navigation',
    sources: [{ id: 'video', uri: 'file:///back.mp4', displayName: 'Video', storageMode: 'copied',
      width: 1080, height: 1920, rotation: 0, frameRate: 30, durationMs: 6000 }],
  });
  project.lifecycle.status = 'saved';
  project.captions = [{ id: 'cue', text: 'Original caption', startMs: 0, endMs: 2000, wordIds: [] }];
  if (translated) project.captionTracks.translations = [{
    id: 'fr', kind: 'translation', sourceTrackId: 'captions', sourceLanguageTag: 'en',
    languageTag: 'fr', displayName: 'French', visible: true, origin: 'manual', provider: { id: 'manual' },
    cues: [{ id: 'fr:cue', sourceCaptionId: 'cue', sourceTextSnapshot: 'Original caption',
      text: 'Bonjour', reviewed: true, status: 'reviewed', startMs: 0, endMs: 2000, timelineVisible: true }],
  }];
  return project;
}

function mount(t, initialProject = fixture()) {
  const slots = [], listeners = new Map(), frames = new Map(), hookModules = new Map();
  let cursor = 0, dirty = true, effects = [], tree, frameId = 0, keyboardVisible = false;
  const calls = { alerts: [], exits: [], writes: [], scrolls: [], dismisses: 0 };
  const sameDeps = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  function memo(factory, deps) {
    const index = cursor++;
    if (!slots[index] || !sameDeps(slots[index].deps, deps)) slots[index] = { value: factory(), deps };
    return slots[index].value;
  }
  const react = {
    useMemo: memo, useCallback: (callback, deps) => memo(() => callback, deps),
    useRef: (value) => memo(() => ({ current: value }), []),
    useState(initial) {
      const index = cursor++;
      slots[index] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [slots[index].value, (value) => {
        const next = typeof value === 'function' ? value(slots[index].value) : value;
        if (!Object.is(next, slots[index].value)) { slots[index].value = next; dirty = true; }
      }];
    },
    useEffect(callback, deps) {
      const index = cursor++;
      if (!slots[index] || !sameDeps(slots[index].deps, deps)) effects.push(() => {
        slots[index]?.cleanup?.();
        slots[index] = { deps, cleanup: callback() };
      });
    },
  };
  function subscribe(name, callback) {
    const entries = listeners.get(name) ?? new Set();
    listeners.set(name, entries); entries.add(callback);
    return () => entries.delete(callback);
  }
  const navigation = {
    addListener: subscribe,
    dispatch: (action) => calls.exits.push(['dispatch', action]),
    goBack: () => routeBack(),
    canGoBack: () => true,
  };
  const transport = {
    currentMs: 600, isPlaying: false, player: 'a', phase: 'ready', isGap: false,
    pause() { if (transport.isPlaying) { transport.isPlaying = false; dirty = true; } },
    seek(ms) { transport.currentMs = ms; dirty = true; },
    synchronizeProject() {},
  };
  const native = Object.fromEntries(['ActivityIndicator', 'Modal', 'Pressable', 'ScrollView', 'Text', 'TextInput', 'View']
    .map((name) => [name, name]));
  native.Platform = { OS: 'android', select: (options) => options.android ?? options.default };
  native.BackHandler = {
    addEventListener: (name, callback) => ({ remove: subscribe(name, callback) }),
    exitApp: () => calls.exits.push(['exitApp']),
  };
  native.Keyboard = {
    isVisible: () => keyboardVisible,
    dismiss: () => { calls.dismisses++; },
    addListener: (name, callback) => ({ remove: subscribe(name, callback) }),
  };
  native.Alert = { alert: (...args) => calls.alerts.push(args) };
  native.useWindowDimensions = () => ({ width: 360, height: 800 });
  native.Animated = {
    ValueXY: class {
      constructor(value) { this.value = value; }
      setValue(value) { this.value = value; }
      getTranslateTransform() { return [{ translateX: this.value.x }, { translateY: this.value.y }]; }
    },
    timing: () => ({ start() {}, stop() {} }),
  };
  const services = {
    createEditorSession,
    checkpointEditorProject: async (project) => { calls.writes.push(project); return project; },
    saveEditorDraft: async (project) => { calls.exits.push(['save', project]); return project; },
    discardEditorSession: async () => { calls.exits.push(['discard']); },
    cancelProjectCaptionGeneration: async () => true,
    cancelProjectVideoExport: async () => {},
    validateProjectSources: async () => {},
    isCaptionModelReady: async () => true, NATURAL_TRANSLATION_MODEL_LABEL: 'Test',
    registerCaptionTranslationResources: () => () => {},
    ProjectPersistenceError: class extends Error {},
  };
  const hooks = {
    useTimelineVideoController: () => transport,
    useTimelineAudioController() {}, useProjectAudioWaveforms() {}, useForegroundOperation: () => ({}),
    useEditorRuntimePolicy: (blockingUi) => ({ mediaAdmitted: !blockingUi }),
    useProjectCaptionTranslation: () => ({ busy: false, cancelling: false }),
  };
  const jsx = (type, props) => ({ type, props: props ?? {} });
  function load(name) {
    if (name === 'react') return react;
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
    if (name === 'react-native') return native;
    if (name === 'expo-router') return { useNavigation: () => navigation };
    if (name === 'expo-video') return { VideoView: 'VideoView' };
    if (name === 'expo-audio') return {
      AudioModule: { requestRecordingPermissionsAsync: async () => ({ granted: false }), setAudioModeAsync: async () => undefined },
      RecordingPresets: { HIGH_QUALITY: {} },
      useAudioRecorder: () => ({ uri: null, prepareToRecordAsync: async () => undefined, record() {}, stop: async () => undefined }),
      useAudioRecorderState: () => ({ isRecording: false, durationMillis: 0, metering: -60 }),
    };
    if (name === 'react-native-safe-area-context') return { useSafeAreaInsets: () => ({ bottom: 0 }) };
    if (name.startsWith('@/components/')) return new Proxy({}, { get: (_object, key) => key });
    if (name.startsWith('@/services/')) return services;
    if (name === '@/lib/ui-theme') return { chrome: { radius: { md: 8, pill: 16 } } };
    if (name === '@/lib/font-catalog') return {};
    if (name.startsWith('@/lib/')) return requireLocal('../src/lib/' + name.slice('@/lib/'.length) + '.ts');
    if (name.startsWith('@/hooks/')) {
      if (Object.keys(hooks).some((key) => name.endsWith(key.replace(/[A-Z]/g, (letter) => '-' + letter.toLowerCase())))) return hooks;
      if (!hookModules.has(name)) {
        const exports = {};
        hookModules.set(name, exports);
        runInNewContext(compile(readFileSync(new URL('../src/' + name.slice(2) + '.ts', import.meta.url), 'utf8')),
          { ...environment, exports });
      }
      return hookModules.get(name);
    }
    throw new Error('Unexpected editor dependency: ' + name);
  }
  const environment = {
    require: load, Error, setTimeout, clearTimeout, queueMicrotask,
    requestAnimationFrame(callback) { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame(id) { frames.delete(id); },
  };
  const exports = {};
  runInNewContext(compiled, { ...environment, exports });
  // Imported children remain boundary nodes, as in the coordinator contracts.
  // Overlay cases use navigation's removal event explicitly: native Modal
  // dispatch is not faked by directly invoking a child's onClose callback.
  function all(predicate, node = tree, result = [], hidden = false) {
    if (!node || typeof node !== 'object') return result;
    if (Array.isArray(node)) { node.forEach((child) => all(predicate, child, result, hidden)); return result; }
    const styles = [node.props?.style].flat().filter(Boolean);
    hidden ||= node.props?.visible === false || styles.some((style) => style.display === 'none');
    if (!hidden && predicate(node)) result.push(node);
    all(predicate, node.props?.children ?? null, result, hidden);
    return result;
  }
  function render() {
    let passes = 0;
    do {
      assert.ok(++passes < 25, 'workspace settles after input');
      dirty = false; cursor = 0; effects = [];
      tree = exports.Workspace({ initialProject });
      for (const node of all((node) => node.type === 'ScrollView' && node.props.ref)) {
        node.props.ref.current = { scrollTo: (request) => calls.scrolls.push(plain(request)) };
      }
      effects.forEach((effect) => effect());
    } while (dirty);
  }
  function routeBack() {
    let prevented = false;
    const event = { data: { action: { type: 'GO_BACK' } }, preventDefault: () => { prevented = true; } };
    for (const callback of listeners.get('beforeRemove') ?? []) callback(event);
    if (!prevented) navigation.dispatch(event.data.action);
    render();
  }
  function androidBack() {
    // Android consumes the IME Back before JS receives hardwareBackPress.
    if (keyboardVisible) { keyboard(false); return; }
    const consumed = [...(listeners.get('hardwareBackPress') ?? [])].reverse().some((callback) => callback() === true);
    if (consumed) render(); else routeBack();
  }
  function keyboard(value) {
    keyboardVisible = value;
    for (const callback of listeners.get(value ? 'keyboardDidShow' : 'keyboardDidHide') ?? []) callback({ endCoordinates: { height: value ? 300 : 0 } });
    render();
  }
  const timeline = () => all((node) => typeof node.props.onSeek === 'function' && Array.isArray(node.props.clips))[0];
  const script = () => all((node) => typeof node.props.onDraftChange === 'function')[0];
  function press(label, toolbar = false) {
    const matches = all((node) => typeof node.props.onPress === 'function'
      && (node.props.label === label || node.props.accessibilityLabel === label)
      && (!toolbar || Object.hasOwn(node.props, 'active')));
    assert.ok(matches.length, 'reachable control: ' + label);
    const node = matches.at(-1);
    assert.ok(!node.props.disabled, label + ' is enabled');
    node.props.onPress(); render();
  }
  function layout(y) {
    const scroller = all((node) => node.type === 'ScrollView' && node.props.ref)[0];
    assert.ok(scroller, 'visible vertical editor scroller');
    scroller.props.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 360, height: 420 } } });
    scroller.props.onContentSizeChange?.(360, 1400);
    for (const node of all((node) => node.props.children === timeline())) {
      node.props.onLayout?.({ nativeEvent: { layout: { x: 0, y: 146, width: 360, height: 320 } } });
    }
    scroller.props.onScroll?.({ nativeEvent: { contentOffset: { x: 0, y },
      layoutMeasurement: { width: 360, height: 420 }, contentSize: { width: 360, height: 1400 } } });
    render();
  }
  function frame() {
    const pending = [...frames.values()]; frames.clear(); pending.forEach((callback) => callback()); render();
  }
  render();
  t.after(() => { for (const slot of slots) slot?.cleanup?.(); frames.clear(); });
  return { all, calls, press, render, routeBack, androidBack, keyboard, timeline, script, layout, frame, transport };
}

function noExit(h) {
  assert.equal(h.calls.alerts.length, 0, 'unwinding UI must not request save/discard');
  assert.deepEqual(h.calls.exits, [], 'unwinding UI must not leave or finalize the project');
}
const activeTool = (h, label) => h.all((node) => node.props.label === label && node.props.active === true).length > 0;

test('Android owns the first Back while the script keyboard is visible', (t) => {
  const h = mount(t);
  h.press('Edit captions');
  assert.ok(h.script(), 'script editing is open');
  h.script().props.onKeyboardChange(true); h.keyboard(true);
  const before = plain(h.script().props.captions);
  h.androidBack();
  assert.ok(h.script(), 'IME dismissal must not close the script');
  assert.deepEqual(plain(h.script().props.captions), before);
  assert.equal(h.calls.dismisses, 0, 'JS must not dismiss the Android-owned keyboard');
  assert.deepEqual(h.calls.scrolls, []);
  noExit(h);
  h.androidBack();
  noExit(h);
  assert.equal(h.script(), undefined, 'the next Back reaches the production editor close path');
  assert.ok(h.timeline());
});

for (const selected of [false, true]) {
  test(`Back returns ${selected ? 'a selected caption' : 'the script editor'} to the timeline`, (t) => {
    const h = mount(t);
    if (selected) { h.timeline().props.onSelectCaption(h.timeline().props.captions[0]); h.render(); }
    h.press('Edit captions');
    assert.ok(h.script());
    const captions = plain(h.script().props.captions), time = h.transport.currentMs;
    h.androidBack();
    noExit(h);
    assert.equal(h.script(), undefined, 'one Back closes the editor');
    assert.ok(h.timeline(), 'timeline is visible again');
    h.layout(0); h.frame();
    assert.deepEqual(plain(h.timeline().props.captions), captions, 'Back preserves committed captions');
    assert.equal(h.transport.currentMs, time, 'Back must not seek');
  });
}

for (const scenario of [
  { name: 'font browser', open: 'Fonts', identify: (props) => typeof props.previewText === 'string' },
  { name: 'caption style scope', open: 'White', identify: (props) => typeof props.changeLabel === 'string' },
  { name: 'dual editor', open: 'Open optional dual subtitles', identify: (props) => Array.isArray(props.pairs) },
  { name: 'dual language picker', open: 'Open optional dual subtitles', translated: false,
    identify: (props) => typeof props.automaticModelLabel === 'string' },
]) {
  test(`navigation Back closes the ${scenario.name} and retains its timeline parent`, (t) => {
    const h = mount(t, fixture(scenario.translated !== false));
    h.press(scenario.open);
    if (scenario.translated === false) {
      const explanation = h.calls.alerts.pop();
      const choose = explanation?.[2].find((button) => button.text === 'Choose language');
      assert.equal(typeof choose?.onPress, 'function', 'follow the existing dual-subtitle introduction');
      choose.onPress(); h.render();
    }
    assert.equal(h.all((node) => node.props.visible === true && scenario.identify(node.props)).length, 1);
    h.routeBack();
    noExit(h);
    assert.equal(h.all((node) => node.props.visible === true && scenario.identify(node.props)).length, 0);
    assert.ok(h.timeline());
    assert.ok(activeTool(h, 'Captions'), 'closing a child must preserve the parent tool');
  });
}

test('successive Back events unwind submenu, selection, and vertical scroll separately', (t) => {
  const h = mount(t);
  h.layout(560); h.press('Fonts');
  const fontBrowser = (node) => node.props.visible === true && typeof node.props.previewText === 'string';
  assert.equal(h.all(fontBrowser).length, 1, 'Fonts opens its editor modal');
  const scrollCount = h.calls.scrolls.length;
  h.routeBack(); noExit(h);
  assert.equal(h.all(fontBrowser).length, 0, 'first Back closes the font browser');
  assert.ok(activeTool(h, 'Captions'), 'first Back retains the underlying tool');
  assert.equal(h.calls.scrolls.length, scrollCount, 'closing a submenu must not also scroll the parent');
  h.timeline().props.onSelectCaption(h.timeline().props.captions[0]); h.render();
  h.androidBack(); noExit(h);
  assert.equal(h.calls.scrolls.length, scrollCount, 'clearing selection is one step');
  h.androidBack(); noExit(h); h.frame();
  assert.equal(h.calls.scrolls.at(-1)?.y, 146, 'third Back returns the vertical timeline to its measured root');
  h.layout(146);
  h.androidBack();
  assert.equal(h.calls.alerts.length, 1, 'only the following Back may request exit');
});

for (const offset of [80, 560]) {
  test(`Back at vertical offset ${offset} returns to the top before asking to exit`, (t) => {
    const h = mount(t);
    h.layout(offset);
    h.androidBack(); noExit(h); h.frame();
    assert.equal(h.calls.scrolls.at(-1)?.y, 146);
    assert.equal(h.transport.currentMs, 600, 'vertical navigation preserves playhead time');
    h.layout(146);
    h.androidBack();
    assert.equal(h.calls.alerts.length, 1);
  });
}

test('Back from the already-rooted top timeline prompts once and Keep editing cancels exit', (t) => {
  const h = mount(t);
  h.layout(146); h.androidBack();
  assert.equal(h.calls.alerts.length, 1);
  const buttons = h.calls.alerts[0][2];
  assert.ok(buttons.some((button) => /save/i.test(button.text)));
  assert.ok(buttons.some((button) => /discard/i.test(button.text)));
  assert.deepEqual(h.calls.exits, [], 'requesting a choice must not persist or navigate');
  h.androidBack();
  assert.equal(h.calls.alerts.length, 1, 'repeated Back must not stack exit prompts');
  const cancel = buttons.find((button) => button.style === 'cancel');
  assert.equal(typeof cancel?.onPress, 'function');
  cancel.onPress(); h.render();
  assert.ok(h.timeline());
  assert.deepEqual(h.calls.exits, []);
  h.androidBack();
  assert.equal(h.calls.alerts.length, 2, 'Keep editing releases the exit prompt guard');
});

test('cancellable work and non-cancellable work have explicit Back ownership', () => {
  const root = {
    interactionLocked: false, captionGenerationActive: false, videoExportActive: false,
    textEditorOpen: false, fontBrowserOpen: false, styleScopeOpen: false,
    transitionTimingOpen: false, audioSourceOpen: false, watermarkOpen: false, languagePickerOpen: false,
    dualCaptionEditorOpen: false, scriptEditorOpen: false, selectionActive: false,
    timelineRooted: true,
  };
  assert.equal(resolveEditorBackStep({ ...root, captionGenerationActive: true }), 'cancel-caption-generation');
  assert.equal(resolveEditorBackStep({ ...root, videoExportActive: true }), 'cancel-video-export');
  assert.equal(resolveEditorBackStep({ ...root, interactionLocked: true, videoExportActive: true }), 'blocked');
});

test('dirty child editors own route Back instead of parent state deletion', () => {
  assert.match(source, /textLayerBackRequestRef\.current/);
  assert.match(source, /languagePickerBackRequestRef\.current/);
  assert.match(source, /onBackRequestChange=\{registerTextLayerBackRequest\}/);
  assert.match(source, /onBackRequestChange=\{registerLanguagePickerBackRequest\}/);
});


test('watermark editor closes before navigating away from the timeline', () => {
  const state = { interactionLocked: false, captionGenerationActive: false, videoExportActive: false, textEditorOpen: false, fontBrowserOpen: false, styleScopeOpen: false, transitionTimingOpen: false, voiceoverOpen: false, audioSourceOpen: false, watermarkOpen: true, languagePickerOpen: false, dualCaptionEditorOpen: false, scriptEditorOpen: false, selectionActive: false, timelineRooted: true };
  assert.equal(resolveEditorBackStep(state), 'close-watermark');
});

