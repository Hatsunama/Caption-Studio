import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/hooks/use-script-editor-exit.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const layout = (y, height) => ({ nativeEvent: { layout: { x: 0, y, width: 360, height } } });

// Run the production hook with ordered keyboard/layout events and frame cleanup.
function mount() {
  const slots = [], frames = new Map(), listeners = new Map(), scrolls = [];
  const scrollRef = { current: { scrollTo: (request) => scrolls.push({ ...request }) } };
  let cursor = 0, effects = [], open = false, keyboard = false, nextFrame = 0, api, dismisses = 0, closes = 0;
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const react = {
    useRef(value) { const index = cursor++; slots[index] ??= { current: value }; return slots[index]; },
    useCallback(callback, deps) {
      const index = cursor++;
      if (!same(slots[index]?.deps, deps)) slots[index] = { deps, callback };
      return slots[index].callback;
    },
    useEffect(callback, deps) {
      const index = cursor++;
      if (!same(slots[index]?.deps, deps)) effects.push(() => {
        slots[index]?.cleanup?.(); slots[index] = { deps, cleanup: callback() };
      });
    },
  };
  const exports = {};
  runInNewContext(compiled, {
    exports,
    require(name) {
      if (name === 'react') return react;
      if (name === 'react-native') return { Keyboard: {
        isVisible: () => keyboard,
        dismiss: () => { dismisses++; },
        addListener(name, callback) { listeners.set(name, callback); return { remove: () => listeners.delete(name) }; },
      } };
      throw new Error(`Unexpected dependency: ${name}`);
    },
    requestAnimationFrame(callback) { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame(id) { frames.delete(id); },
  });
  function render() {
    cursor = 0; effects = [];
    api = exports.useScriptEditorExit(open, scrollRef, () => { closes++; open = false; });
    for (const effect of effects) effect();
  }
  render();
  return {
    scrolls, frames, listeners,
    get dismisses() { return dismisses; }, get closes() { return closes; },
    open() { open = true; render(); },
    close() { api.close(); render(); },
    viewport(height) { api.onScrollLayout(layout(0, height)); },
    timeline(y, height = 320) { api.onTimelineLayout(layout(y, height)); },
    content() { api.scheduleTimelineReveal(); },
    keyboard(value, notify = true) { keyboard = value; if (!value && notify) listeners.get('keyboardDidHide')?.(); },
    frame() { const queued = [...frames.values()]; frames.clear(); queued.forEach((callback) => callback()); },
    unmount() { for (const slot of slots) slot?.cleanup?.(); },
  };
}

test('exit waits for keyboard dismissal and reveals the measured timeline top once', () => {
  const h = mount(); h.viewport(500); h.timeline(138); h.open(); h.keyboard(true);
  h.timeline(0, 0); h.viewport(0); h.close();
  assert.equal(h.dismisses, 1); assert.equal(h.closes, 1);
  h.frame(); assert.deepEqual(h.scrolls, [], 'keyboard still owns the reduced window');
  h.viewport(460); h.content(); h.timeline(154); h.keyboard(false);
  assert.equal(h.frames.size, 1, 'layout and keyboard events coalesce');
  h.frame(); assert.deepEqual(h.scrolls, [{ y: 154, animated: false }]);
  h.timeline(160); h.viewport(480); h.content(); h.keyboard(false); h.frame();
  assert.equal(h.scrolls.length, 1, 'later layout must not override user scrolling');
});

test('exit without keyboard works when hiding and showing emits no new anchor layout', () => {
  const h = mount(); h.viewport(500); h.timeline(126); h.open(); h.close(); h.frame();
  assert.deepEqual(h.scrolls, [{ y: 126, animated: false }]);
});

test('exit before initial layout waits for a usable viewport and timeline anchor', () => {
  const h = mount(); h.open(); h.close(); h.frame();
  h.timeline(140); h.viewport(0); h.frame(); assert.deepEqual(h.scrolls, []);
  h.viewport(450); h.frame(); assert.deepEqual(h.scrolls, [{ y: 140, animated: false }]);
});

test('late layout retries after keyboard closes even if the hide notification was missed', () => {
  const h = mount(); h.viewport(400); h.timeline(130); h.open(); h.keyboard(true); h.close(); h.frame();
  h.keyboard(false, false); h.content(); h.frame();
  assert.deepEqual(h.scrolls, [{ y: 130, animated: false }]);
});

test('reopening and unmounting cancel stale exit work', () => {
  const h = mount(); h.viewport(500); h.timeline(134); h.open(); h.close();
  assert.equal(h.frames.size, 1);
  h.open(); h.frame(); h.keyboard(false); h.content(); h.frame();
  assert.deepEqual(h.scrolls, []);
  h.close(); h.frame(); assert.equal(h.scrolls.length, 1);
  h.open(); h.close(); h.unmount(); h.frame();
  assert.equal(h.scrolls.length, 1); assert.equal(h.listeners.size, 0);
});

test('ordinary editor layout never requests a reveal', () => {
  const h = mount(); h.viewport(500); h.timeline(132); h.content(); h.keyboard(false); h.frame();
  assert.deepEqual(h.scrolls, []);
});

const editor = readFileSync(process.env.CAPTION_EDITOR_SOURCE ?? new URL('../src/app/editor.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('editor.tsx', editor, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const workspace = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'EditorWorkspace');
const declarations = workspace.body.statements.filter(ts.isVariableStatement).flatMap((node) => [...node.declarationList.declarations]);
const initializer = (name) => declarations.find((node) => node.name.getText(ast) === name)?.initializer;
function evaluate(node, context) {
  assert.ok(node, 'production workspace must wire the exit boundary');
  const sandbox = { ...context };
  runInNewContext(ts.transpileModule(`result = (${node.getText(ast)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, sandbox);
  return sandbox.result;
}

test('Done and Cancel share presentation-only cleanup; rejected or stale saves stay open', async () => {
  let closes = 0, receipt;
  const close = () => { closes++; };
  const save = evaluate(initializer('commitCaptionScript'), {
    commitEditorProject: async () => { if (receipt instanceof Error) throw receipt; return receipt; },
    editorSession: { isCurrent: (value) => value.current },
    selectedCaptionId: 'cue-1', setSelectedCaptionId: () => assert.fail('existing selection must survive'),
    changedPrimaryCaptionTextIds: () => [], scriptExit: { close },
  });
  receipt = null; await save([]); assert.equal(closes, 0);
  receipt = { current: false }; await save([]); assert.equal(closes, 0);
  receipt = new Error('save failed'); await assert.rejects(save([]), /save failed/); assert.equal(closes, 0);
  receipt = { current: true, before: {}, project: { captions: [{ id: 'cue-1' }], captionTracks: { translations: [] } } };
  await save([]); assert.equal(closes, 1);

  const nodes = [];
  const visit = (node) => { if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) nodes.push(node); ts.forEachChild(node, visit); };
  visit(workspace);
  const script = nodes.find((node) => node.tagName.getText(ast) === 'ScriptEditor');
  const attr = (node, name) => node.attributes.properties.find((prop) => prop.name?.text === name)?.initializer?.expression;
  assert.equal(evaluate(attr(script, 'onCancel'), { scriptExit: { close } }), close);
  assert.equal(attr(script, 'onSave').getText(ast), 'commitCaptionScript');
  const scroller = nodes.find((node) => node.tagName.getText(ast) === 'ScrollView' && attr(node, 'ref')?.getText(ast) === 'editorScrollRef');
  assert.ok(scroller);
  assert.equal(attr(scroller, 'onLayout').getText(ast), 'scriptExit.onScrollLayout');
  assert.equal(attr(scroller, 'onContentSizeChange').getText(ast), 'scriptExit.scheduleTimelineReveal');
  const timeline = nodes.find((node) => node.tagName.getText(ast) === 'LayerTimeline');
  assert.equal(attr(timeline.parent.openingElement, 'onLayout').getText(ast), 'scriptExit.onTimelineLayout');
  assert.equal(attr(timeline, 'onSeek').getText(ast), 'seekTimeline', 'vertical reveal must not replace timeline seeking');

  const changes = [];
  // No project/transport/tool setters are supplied: accidental ownership changes throw.
  evaluate(initializer('scriptExit').arguments[2], Object.fromEntries([
    'setScriptKeyboardOpen', 'setScriptEditingCaptionId', 'setScriptDraftCaptions', 'setScriptEditorOpen',
  ].map((name) => [name, (value) => changes.push([name, value])])))();
  assert.deepEqual(changes, [
    ['setScriptKeyboardOpen', false], ['setScriptEditingCaptionId', undefined],
    ['setScriptDraftCaptions', null], ['setScriptEditorOpen', false],
  ]);
});
