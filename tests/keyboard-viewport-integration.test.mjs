import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const compilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS,
  jsx: ts.JsxEmit.ReactJSX,
};
const compile = path => ts.transpileModule(
  readFileSync(new URL(path, import.meta.url), 'utf8'), { compilerOptions },
).outputText;
const compiledHook = compile('../src/hooks/use-keyboard-viewport.ts');
const compiledComponent = compile('../src/components/editor/keyboard-viewport.tsx');
const compiledGeometry = compile('../src/lib/keyboard-viewport.ts');
const editorSource = readFileSync(new URL('../src/app/editor.tsx', import.meta.url), 'utf8');

function evaluate(code, dependencies) {
  const module = { exports: {} };
  runInNewContext(code, {
    module,
    exports: module.exports,
    require(id) {
      assert.ok(Object.hasOwn(dependencies, id), `Unexpected import: ${id}`);
      return dependencies[id];
    },
  });
  return module.exports;
}

// Only React scheduling and native hosts are faked. Product hook, component,
// and geometry run together; measurements complete only when the test says so.
function render(props = {}, platform = 'android') {
  let dimensions = { width: 400, height: 800, scale: 1, fontScale: 1 };
  let visible = false;
  let metrics;
  let cursor = 0;
  let dirty = true;
  let disposed = false;
  let viewport;
  let root;
  let mountCount = 0;
  const slots = [];
  const effects = [];
  const requests = [];
  const listeners = new Map();
  const subscriptions = [];
  const child = { type: 'View', key: null, props: { testID: 'editor-child' } };
  let currentProps = { children: child, ...props };
  const sameDeps = (a, b) => a && b && a.length === b.length
    && a.every((value, index) => Object.is(value, b[index]));
  const react = {
    useRef(initial) {
      const index = cursor++;
      slots[index] ??= { current: initial };
      return slots[index];
    },
    useState(initial) {
      const index = cursor++;
      if (!slots[index]) {
        const slot = { value: typeof initial === 'function' ? initial() : initial };
        slot.set = next => {
          const value = typeof next === 'function' ? next(slot.value) : next;
          if (!Object.is(value, slot.value)) {
            slot.value = value;
            dirty = true;
          }
        };
        slots[index] = slot;
      }
      return [slots[index].value, slots[index].set];
    },
    useCallback(callback, deps) {
      const index = cursor++;
      if (!sameDeps(slots[index]?.deps, deps)) slots[index] = { callback, deps };
      return slots[index].callback;
    },
    useMemo(factory, deps) {
      const index = cursor++;
      if (!sameDeps(slots[index]?.deps, deps)) slots[index] = { value: factory(), deps };
      return slots[index].value;
    },
    useEffect(callback, deps) {
      const index = cursor++;
      if (!sameDeps(slots[index]?.deps, deps)) {
        const previous = slots[index];
        const slot = { deps, cleanup: undefined };
        slots[index] = slot;
        effects.push(() => {
          previous?.cleanup?.();
          slot.cleanup = callback();
        });
      }
    },
  };
  const native = {
    Platform: { OS: platform },
    View: 'View',
    KeyboardAvoidingView: 'KAV',
    useWindowDimensions: () => dimensions,
    Keyboard: {
      isVisible: () => visible,
      metrics: () => metrics,
      addListener(name, callback) {
        subscriptions.push(name);
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name).add(callback);
        return { remove: () => listeners.get(name).delete(callback) };
      },
    },
  };
  const geometry = evaluate(compiledGeometry, {});
  const hook = evaluate(compiledHook, {
    react,
    'react-native': native,
    '@/lib/keyboard-viewport': geometry,
  });
  const jsx = (type, props, key = null) => ({ type, props, key });
  const component = evaluate(compiledComponent, {
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': native,
    '@/hooks/use-keyboard-viewport': {
      useKeyboardViewport(...args) {
        viewport = hook.useKeyboardViewport(...args);
        return viewport;
      },
    },
  });
  function attach(ref, value) {
    if (typeof ref === 'function') ref(value);
    else if (ref) ref.current = value;
  }
  function release(node) {
    if (!node) return;
    attach(node.props.ref, null);
    release(node.child);
  }
  function reconcile(previous, element) {
    if (element == null || typeof element !== 'object') return undefined;
    let node = previous;
    if (!node || node.type !== element.type || node.key !== element.key) {
      release(node);
      node = {
        type: element.type,
        key: element.key,
        props: {},
        native: { measureInWindow: callback => requests.push(callback) },
      };
      mountCount++;
    }
    const oldRef = node.props.ref;
    node.props = element.props;
    node.child = reconcile(node.child, element.props.children);
    if (oldRef !== node.props.ref) {
      attach(oldRef, null);
      attach(node.props.ref, node.native);
    }
    return node;
  }
  function flush() {
    assert.equal(disposed, false);
    let passes = 0;
    while (dirty || effects.length) {
      assert.ok(++passes <= 50, 'Render/effect scheduling must settle');
      if (dirty) {
        dirty = false;
        cursor = 0;
        root = reconcile(root, component.KeyboardViewport(currentProps));
      }
      for (const effect of effects.splice(0)) effect();
    }
  }
  flush();
  return {
    child,
    subscriptions,
    get root() { return root; },
    get frame() { return root.child; },
    get content() { return root.child.child; },
    get viewport() { return viewport; },
    get mountCount() { return mountCount; },
    measure(frame) {
      assert.ok(requests.length > 0, 'Native frame must request measurement');
      const callbacks = requests.splice(0);
      for (const callback of callbacks) callback(frame.x, frame.y, frame.width, frame.height);
      flush();
    },
    layout(width, height) {
      root.child.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width, height } } });
      flush();
    },
    resize(width, height) {
      dimensions = { ...dimensions, width, height };
      dirty = true;
      flush();
    },
    keyboard(name, coordinates) {
      visible = name !== 'keyboardDidHide';
      metrics = visible ? coordinates : undefined;
      const event = { endCoordinates: coordinates, duration: 0, easing: 'keyboard' };
      for (const callback of [...(listeners.get(name) ?? [])]) callback(event);
      flush();
    },
    update(next) {
      currentProps = { ...currentProps, ...next };
      dirty = true;
      flush();
    },
    dispose() {
      release(root);
      for (const slot of slots) slot?.cleanup?.();
      disposed = true;
    },
  };
}

const portraitFrame = { x: 0, y: 0, width: 400, height: 800 };
const portraitKeyboard = { screenX: 0, screenY: 640, width: 400, height: 160 };
const landscapeFrame = { x: 0, y: 0, width: 800, height: 480 };
const landscapeKeyboard = { screenX: 0, screenY: 320, width: 800, height: 160 };

function assertNativeContract(h) {
  assert.equal(typeof h.viewport.attachFrame, 'function');
  assert.equal(h.frame.props.ref, h.viewport.attachFrame);
  assert.equal(h.frame.props.onLayout, h.viewport.onLayout);
  assert.equal(typeof h.viewport.measurementPending, 'boolean');
  assert.equal(h.frame.props.style.marginBottom, undefined);
  assert.equal(h.content.props.style.marginBottom, h.viewport.bottomOverlap);
}

test('render callback removes only covered safe area and preserves native child identity', t => {
  const child = { type: 'View', key: null, props: { testID: 'callback-child' } };
  const insets = [];
  const h = render({ safeAreaBottom: 72, children: ({ safeAreaBottom }) => {
    insets.push(safeAreaBottom);
    return child;
  } });
  t.after(() => h.dispose());
  assert.equal(insets.at(-1), 72);
  const editorChild = h.content.child;
  const mounts = h.mountCount;
  editorChild.native.focused = true;
  editorChild.native.selection = { start: 3, end: 7 };
  const identity = () => {
    assert.equal(h.content.props.children, child);
    assert.equal(h.content.child, editorChild);
    assert.equal(h.mountCount, mounts);
    assert.equal(editorChild.native.focused, true);
    assert.deepEqual(editorChild.native.selection, { start: 3, end: 7 });
  };
  h.keyboard('keyboardDidShow', portraitKeyboard);
  assert.equal(insets.at(-1), 72);
  h.measure(portraitFrame);
  assert.equal(insets.at(-1), 0);
  assert.equal(h.content.props.style.marginBottom, 160); identity();
  h.resize(400, 640);
  assert.equal(insets.at(-1), 72); identity();
  h.measure({ ...portraitFrame, height: 640 });
  assert.equal(insets.at(-1), 0);
  assert.equal(h.content.props.style.marginBottom, 0); identity();
  h.keyboard('keyboardDidShow', { ...portraitKeyboard, screenY: 400, height: 100 });
  assert.equal(insets.at(-1), 72); identity();
  h.keyboard('keyboardDidShow', portraitKeyboard);
  assert.equal(insets.at(-1), 0); identity();
  h.update({ safeAreaBottom: 24 }); assert.equal(insets.at(-1), 0); identity();
  h.keyboard('keyboardDidHide', portraitKeyboard);
  assert.equal(insets.at(-1), 24); identity();
  h.keyboard('keyboardDidShow', portraitKeyboard);
  h.measure({ ...portraitFrame, height: 640 });
  h.update({ enabled: false }); assert.equal(insets.at(-1), 24); identity();
  h.update({ enabled: true }); assert.equal(insets.at(-1), 24); identity();
  h.measure({ ...portraitFrame, height: 640 });
  assert.equal(insets.at(-1), 0); identity();
  assert.equal(h.subscriptions.length, 6, 'Only two listeners per active geometry generation');
});

test('iOS callback keeps supplied inset and existing avoidance; omitted inset defaults to zero', t => {
  const child = { type: 'View', key: null, props: {} };
  const insets = [];
  const ios = render({ safeAreaBottom: 72, children: value => {
    insets.push(value.safeAreaBottom); return child;
  } }, 'ios');
  const defaults = render({ children: value => {
    assert.equal(value.safeAreaBottom, 0); return child;
  } });
  t.after(() => { ios.dispose(); defaults.dispose(); });
  ios.keyboard('keyboardDidShow', portraitKeyboard);
  assert.equal(insets.at(-1), 72);
  assert.equal(ios.root.props.behavior, 'padding');
  assert.equal(ios.root.props.enabled, true);
  assert.equal(ios.content.props.style.marginBottom, 0);
  assert.deepEqual(ios.subscriptions, []);
  assert.equal(defaults.content.props.children, child);
});

test('real keyboard events reserve only content space through the attached native frame', t => {
  const h = render();
  t.after(() => h.dispose());
  assertNativeContract(h);
  const attachFrame = h.viewport.attachFrame;
  h.layout(400, 800);
  h.measure(portraitFrame);
  h.keyboard('keyboardDidShow', portraitKeyboard);
  h.measure(portraitFrame);
  assert.equal(h.content.props.style.marginBottom, 160);
  assert.equal(h.frame.props.style.marginBottom, undefined);
  assert.equal(h.root.props.behavior, undefined);
  assert.equal(h.content.props.children, h.child);
  assert.equal(h.viewport.attachFrame, attachFrame);
  assert.equal(h.viewport.measurementPending, false);
  assert.deepEqual([...new Set(h.subscriptions)].sort(), ['keyboardDidHide', 'keyboardDidShow']);
});

test('open keyboard survives rotation, measurement, and dismissal without remounting children', t => {
  const h = render();
  t.after(() => h.dispose());
  assertNativeContract(h);
  h.measure(portraitFrame);
  h.keyboard('keyboardDidShow', portraitKeyboard);
  h.measure(portraitFrame);
  assert.equal(h.viewport.bottomOverlap, 160);
  const root = h.root;
  const frame = h.frame;
  const content = h.content;
  const editorChild = content.child;
  const mounts = h.mountCount;
  const attachFrame = h.viewport.attachFrame;
  editorChild.native.selection = { start: 3, end: 7 };
  editorChild.native.focused = true;
  function assertIdentity() {
    assert.equal(h.root, root);
    assert.equal(h.frame, frame);
    assert.equal(h.content, content);
    assert.equal(h.content.child, editorChild);
    assert.equal(h.content.props.children, h.child);
    assert.equal(h.mountCount, mounts);
    assert.equal(h.viewport.attachFrame, attachFrame);
    assert.deepEqual(editorChild.native.selection, { start: 3, end: 7 });
    assert.equal(editorChild.native.focused, true);
  }
  h.resize(800, 480);
  assert.equal(h.viewport.measurementPending, true);
  assert.equal(h.content.props.style.marginBottom, 160, 'Keep the bounded last known reservation during rotation');
  assertIdentity();
  h.keyboard('keyboardDidShow', landscapeKeyboard);
  h.layout(800, 480);
  assert.equal(h.viewport.measurementPending, true);
  assert.equal(h.content.props.style.marginBottom, 160);
  assertIdentity();
  h.measure(landscapeFrame);
  assert.equal(h.viewport.measurementPending, false);
  assert.equal(h.content.props.style.marginBottom, 160);
  assertIdentity();
  h.keyboard('keyboardDidHide', landscapeKeyboard);
  assert.equal(h.content.props.style.marginBottom, 0, 'Dismissal clears reservation before measurement returns');
  assertIdentity();
  h.layout(800, 480);
  h.measure(landscapeFrame);
  assert.equal(h.content.props.style.marginBottom, 0);
  assert.equal(h.viewport.measurementPending, false);
  assertIdentity();
});

test('an Android caller with an already-resized root receives zero extra reservation', t => {
  const h = render();
  t.after(() => h.dispose());
  assertNativeContract(h);
  h.resize(400, 640);
  h.layout(400, 640);
  h.measure({ x: 0, y: 0, width: 400, height: 640 });
  h.keyboard('keyboardDidShow', portraitKeyboard);
  h.measure({ x: 0, y: 0, width: 400, height: 640 });
  assert.equal(h.content.props.style.marginBottom, 0);
  assert.equal(h.viewport.measurementPending, false);
  assert.equal(h.content.props.children, h.child);
});

test('iOS avoidance and editor-owned nested avoidance remain explicit', t => {
  const ios = render({}, 'ios');
  const editor = render({ iosAvoidance: false, keyboardVerticalOffset: 24 }, 'ios');
  const disabled = render({ enabled: false }, 'android');
  t.after(() => { ios.dispose(); editor.dispose(); disabled.dispose(); });
  assert.equal(ios.root.props.behavior, 'padding');
  assert.equal(ios.root.props.enabled, true);
  assert.equal(editor.root.props.behavior, 'padding');
  assert.equal(editor.root.props.enabled, false);
  assert.equal(editor.root.props.keyboardVerticalOffset, 24);
  for (const h of [ios, editor, disabled]) {
    assert.equal(h.viewport.bottomOverlap, 0);
    assert.equal(h.content.props.style.marginBottom, 0);
    assert.equal(h.viewport.measurementPending, false);
    assert.deepEqual(h.subscriptions, []);
    h.keyboard('keyboardDidShow', portraitKeyboard);
    assert.equal(h.content.props.style.marginBottom, 0);
  }
  assert.equal(disabled.root.props.enabled, false);
});

test('disabling Android avoidance releases an open keyboard reservation immediately', t => {
  const h = render();
  t.after(() => h.dispose());
  h.measure(portraitFrame);
  h.keyboard('keyboardDidShow', portraitKeyboard);
  h.measure(portraitFrame);
  assert.equal(h.content.props.style.marginBottom, 160);
  const editorChild = h.content.child;
  const mounts = h.mountCount;
  h.update({ enabled: false });
  assert.equal(h.content.props.style.marginBottom, 0);
  assert.equal(h.viewport.measurementPending, false);
  assert.equal(h.content.child, editorChild);
  assert.equal(h.mountCount, mounts);
});

test('the editor measured workspace lives inside the keyboard-bounded content without a remount key', () => {
  const editor = ts.createSourceFile('editor.tsx', editorSource,
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let wrapper;
  function visit(node) {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(editor) === 'KeyboardViewport') wrapper = node;
    ts.forEachChild(node, visit);
  }
  visit(editor);
  assert.ok(wrapper);
  assert.equal(wrapper.openingElement.attributes.properties.some(a => a.name?.getText(editor) === 'key'), false);
  const root = wrapper.children.find(n => ts.isJsxElement(n) && n.openingElement.tagName.getText(editor) === 'View');
  assert.ok(root);
  const onLayout = root.openingElement.attributes.properties.find(a => a.name?.getText(editor) === 'onLayout');
  assert.ok(onLayout && ts.isJsxExpression(onLayout.initializer));
  const writes = [];
  runInNewContext('(' + onLayout.initializer.expression.getText(editor) + ')({ nativeEvent: { layout: { height: 170, width: 760 } } })',
    { setWorkspaceHeight: v => writes.push(['height', v]), setWorkspaceWidth: v => writes.push(['width', v]), width: 800 });
  assert.deepEqual(writes, [['height', 170], ['width', 760]]);
});
