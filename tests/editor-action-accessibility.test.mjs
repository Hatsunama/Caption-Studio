import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
const relative = 'Libraries/Components/Pressable/Pressable.js';
const beforeHash = '3e6c095cd9c51cb982236bc2bf19e1bee84f709b09c3187f36c594086894457d';
const afterHash = '14e0c2e0d9a52a51d4401f85c5f360030c348517ddf4bb597ea3d114d6f719d6';
const before = 'disabled: ariaDisabled ?? accessibilityState?.disabled,';
const after = 'disabled: ariaDisabled ?? accessibilityState?.disabled ?? false,';
const hash = value => createHash('sha256').update(value).digest('hex');
const sourceRoot = process.env.RN_SOURCE_ROOT ?? path.join(root, 'node_modules/react-native');
assert.equal(JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'))).version, '0.86.3');
const source = fs.readFileSync(path.join(sourceRoot, relative), 'utf8');
assert.ok([beforeHash, afterHash].includes(hash(source)), 'require exact pinned Pressable bytes');
const pristine = hash(source) === afterHash ? source.replace(after, before) : source;
assert.equal(hash(pristine), beforeHash);

function compile(text, jsx = false) {
  const ast = ts.createSourceFile('owner.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  assert.deepEqual(ast.parseDiagnostics, [], 'extracted production declaration must parse');
  return ts.transpileModule(text, {
    fileName: 'owner.tsx', compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
      jsx: jsx ? ts.JsxEmit.React : ts.JsxEmit.Preserve,
    },
  }).outputText;
}

// Execute actual prop destructuring, accessibility declarations, view defaults and
// Pressability config. Only hook/native adapters are replaced; no second reducer.
function pressableOwner(text) {
  const propsStart = text.indexOf('  const {', text.indexOf('function Pressable('));
  const propsEnd = text.indexOf('  const viewRef', propsStart);
  const stateStart = text.indexOf('  let _accessibilityState', propsEnd);
  const pressedStart = text.indexOf('  const shouldUpdatePressed', propsEnd);
  const stateEnd = text.indexOf('  const eventHandlers', stateStart);
  assert.ok(propsStart > 0 && propsEnd > propsStart && stateStart > propsEnd && stateEnd > stateStart);
  return new Function('props', 'useMemo', compile(
    text.slice(propsStart, propsEnd) +
    '\nconst android_rippleConfig = null; const setPressed = () => {};\n' +
    text.slice(pressedStart, stateStart) +
    text.slice(stateStart, stateEnd) + '\nreturn {view: restPropsWithDefaults, config, style, children};'));
}
const pinnedOwner = pressableOwner(source);
const renderPressable = props => pinnedOwner(props, factory => factory());

// These are real RN Pressability guards, with Flow-compatible TS annotations.
const pressability = fs.readFileSync(path.join(sourceRoot, 'Libraries/Pressability/Pressability.js'), 'utf8');
function handler(name, next) {
  const start = pressability.indexOf('      ' + name + ':');
  const end = pressability.indexOf(next, start);
  assert.ok(start > 0 && end > start);
  const code = compile('return ({' + pressability.slice(start, end) + '\n});');
  // Preserve the lexical this of RN's arrow handlers at their creation site.
  const factory = new Function(code);
  return function (...args) { return factory.call(this)[name](...args); };
}
const shouldStart = handler('onStartShouldSetResponder', '      onResponderGrant:');
const onClick = handler('onClick', '    };');

test('omitted disabled supplies a native boolean false at the real Pressable owner', () => {
  for (const props of [{}, { disabled: undefined }, { disabled: null }, { accessibilityState: {} },
    { 'aria-disabled': undefined, accessibilityState: { disabled: undefined } }]) {
    const result = renderPressable(props);
    assert.equal(result.view.accessibilityState.disabled, false);
    assert.equal(shouldStart.call({ _config: result.config }), true);
  }
});

test('explicit disabled and ARIA/state precedence', () => {
  // Exhaust all combinations rather than just the favorable default path.
  for (const disabled of [undefined, null, false, true]) {
    for (const aria of [undefined, null, false, true]) {
      for (const state of [undefined, null, false, true]) {
        const result = renderPressable({ disabled, 'aria-disabled': aria, accessibilityState: { disabled: state } });
        assert.equal(result.view.accessibilityState.disabled, disabled ?? aria ?? state ?? false);
        assert.equal(result.config.disabled, disabled, 'preserve the independent input guard');
      }
    }
  }
});

test('same Pressable owner clears modeled retained disabled state and preserves explicit true', () => {
  // Model only the native boolean setter's contract. This does not establish
  // which allocation/recycling path caused the device observation, nor model
  // undefined serialization or modify TextInput/editable ownership.
  for (const initiallyEnabled of [true, false]) {
    const modeledHost = { enabled: initiallyEnabled };
    const owner = pressableOwner(source);
    for (const [props, expected] of [[{}, true], [{ disabled: true }, false], [{}, true],
      [{ accessibilityState: { disabled: true } }, false], [{ disabled: undefined }, true],
      [{ 'aria-disabled': true }, false], [{ disabled: false }, true],
      [{ disabled: true }, false], [{ disabled: null }, true]]) {
      const state = owner(props, factory => factory()).view.accessibilityState;
      assert.equal(typeof state.disabled, 'boolean', 'no undefined/null value crosses this boundary');
      modeledHost.enabled = !state.disabled;
      assert.equal(modeledHost.enabled, expected);
    }
  }
});

test('callbacks, input guards, children and style identities remain unchanged', () => {
  const oldOwner = pressableOwner(pristine);
  for (const disabled of [undefined, false, true]) {
    let calls = 0;
    const callback = () => { calls++; };
    for (const style of [{ opacity: 0.35, minHeight: 44 }, () => ({ opacity: 1 })]) {
      const children = () => 'content';
      const props = { disabled, onPress: callback, onLongPress: callback, onPressIn: callback,
        onPressOut: callback, style, children, accessibilityLabel: 'Unchanged', testID: 'owner',
        accessibilityState: { busy: true, checked: 'mixed', selected: true, expanded: false } };
      const old = oldOwner(props, factory => factory());
      const current = renderPressable(props);
      assert.strictEqual(current.style, style);
      assert.strictEqual(current.children, children);
      assert.deepEqual(current.view, { ...old.view, accessibilityState: { ...old.view.accessibilityState,
        disabled: disabled ?? false } });
      for (const key of Object.keys(old.config)) {
        if (typeof old.config[key] === 'function' && key !== 'onPress' && key !== 'onLongPress') {
          assert.equal(current.config[key].toString(), old.config[key].toString());
        } else assert.strictEqual(current.config[key], old.config[key]);
      }
      assert.strictEqual(current.config.onPress, callback);
      assert.equal(shouldStart.call({ _config: current.config }), disabled !== true);
      const count = calls;
      onClick.call({ _config: current.config }, { currentTarget: 1, target: 1 });
      assert.equal(calls - count, disabled === true ? 0 : 1);
      onClick.call({ _config: current.config }, { currentTarget: 1, target: 1, nativeEvent: { pointerType: 'touch' } });
      assert.equal(calls - count, disabled === true ? 0 : 1);
    }
  }
});

function declaration(text, name) {
  const ast = ts.createSourceFile('editor.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const nodes = ast.statements.filter(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.equal(nodes.length, 1);
  return nodes[0].getText(ast);
}
test('execute actual Action declaration without visual or handler changes', () => {
  const working = declaration(fs.readFileSync(path.join(root, 'src/app/editor.tsx'), 'utf8'), 'Action');
  // Measured equal at d85224a and dd2dfd2e before this repair. Do not require
  // historical git objects in shallow CI checkouts to exercise the real owner.
  assert.equal(hash(working), '200684f69542c1718006821d345e207ab9efc91c4ad2171254603a632989d480');
  const chrome = { radius: { md: 13 }, dangerFill: '#danger' };
  const palette = { surfaceRaised: '#surface', text: '#text' };
  const React = { createElement: (type, props, ...children) => ({ type, props, children }) };
  const render = new Function('React', 'Pressable', 'View', 'Text', 'chrome', 'palette',
    compile(working + '\nreturn Action;', true))(React, 'Pressable', 'View', 'Text', chrome, palette);
  for (const disabled of [undefined, false, true]) for (const danger of [false, true]) {
    const callback = () => {};
    const element = render({ label: 'Add text layer', color: '#red', danger, disabled, onPress: callback });
    assert.strictEqual(element.props.onPress, callback);
    assert.equal(element.props.disabled, disabled);
    assert.deepEqual(element.props.style, { minHeight: 44, paddingHorizontal: 14, flexDirection: 'row', gap: 7,
      alignItems: 'center', borderRadius: 13, borderWidth: danger ? 1 : 0,
      borderColor: danger ? '#danger' : 'transparent', backgroundColor: danger ? '#danger' : '#surface',
      opacity: disabled ? 0.35 : 1 });
    assert.equal(renderPressable(element.props).view.accessibilityState.disabled, disabled ?? false);
  }
});

test('analogous optional-disabled wrappers use the same repaired owner without UI edits', () => {
  const React = { createElement: (type, props, ...children) => ({ type, props, children }) };
  const chrome = { radius: { md: 13, pill: 100 }, fill: '#fill', surfaceRaised: '#surface' };
  for (const [file, name] of [
    ['src/components/editor/animation-browser.tsx', 'ScopeButton'],
    ['src/components/editor/scope-sheet.tsx', 'ScopeButton'],
    ['src/components/editor/script-editor.tsx', 'ScriptAction'],
    ['src/app/editor.tsx', 'ToolbarItem'],
  ]) {
    const text = declaration(fs.readFileSync(path.join(root, file), 'utf8'), name);
    const render = new Function('React', 'Pressable', 'View', 'Text', 'chrome', 'palette',
      compile(text + '\nreturn ' + name + ';', true))(React, 'Pressable', 'View', 'Text', chrome, chrome);
    for (const disabled of [undefined, false, true]) {
      const onPress = () => {};
      const element = render({ label: 'Label', title: 'Title', description: 'Description', disabled, onPress });
      assert.strictEqual(element.props.onPress, onPress);
      assert.equal(renderPressable(element.props).view.accessibilityState.disabled, disabled ?? false, file);
    }
    console.log('shared owner source path:', file, name);
  }
});

function fixture(t, installed = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pressable-accessibility-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pkg = path.join(dir, 'node_modules/react-native');
  const target = path.join(pkg, relative);
  if (installed) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ version: '0.86.3' }));
    fs.writeFileSync(target, pristine);
  }
  return { dir, pkg, target };
}
const repair = dir => require('../scripts/repair-pressable-accessibility.js').repairPressableAccessibility(dir);

test('repair changes only pinned declaration, is atomic and idempotent with stable metadata', t => {
  const { dir, target } = fixture(t);
  fs.chmodSync(target, 0o640);
  const mode = fs.statSync(target).mode;
  assert.equal(repair(dir), true);
  assert.equal(fs.readFileSync(target, 'utf8'), pristine.replace(before, after));
  assert.equal(hash(fs.readFileSync(target)), afterHash);
  assert.equal(fs.statSync(target).mode, mode);
  const stamp = fs.statSync(target).mtimeMs;
  assert.equal(repair(dir), false);
  assert.equal(fs.statSync(target).mtimeMs, stamp);
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ['Pressable.js']);
});

test('unknown bytes/versions and incomplete installs abort without publication', t => {
  for (const version of ['0.86.2', '0.86.4', undefined]) {
    const { dir, pkg, target } = fixture(t);
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ version }));
    assert.throws(() => repair(dir), /version/i);
    assert.equal(fs.readFileSync(target, 'utf8'), pristine);
    assert.deepEqual(fs.readdirSync(path.dirname(target)), ['Pressable.js']);
  }
  const { dir, target } = fixture(t);
  fs.appendFileSync(target, '\n');
  assert.throws(() => repair(dir), /hash/i);
  assert.equal(fs.readFileSync(target, 'utf8'), pristine + '\n');
  const missing = fixture(t, false);
  assert.equal(repair(missing.dir), false);
  fs.mkdirSync(path.join(missing.dir, 'node_modules'));
  assert.throws(() => repair(missing.dir));
  fs.mkdirSync(missing.pkg);
  fs.writeFileSync(path.join(missing.pkg, 'package.json'), '{');
  assert.throws(() => repair(missing.dir));
  fs.writeFileSync(path.join(missing.pkg, 'package.json'), '{"version":"0.86.3"}');
  assert.throws(() => repair(missing.dir));
  assert.equal(fs.existsSync(missing.target), false);
});

test('failed rename cleans owned staging and preserves target and unrelated siblings', t => {
  const { dir, target } = fixture(t);
  const sibling = target + '.other.tmp';
  fs.writeFileSync(sibling, 'keep');
  t.mock.method(fs, 'renameSync', () => { throw Error('injected rename failure'); });
  assert.throws(() => repair(dir), /injected rename failure/);
  assert.equal(fs.readFileSync(target, 'utf8'), pristine);
  assert.equal(fs.readFileSync(sibling, 'utf8'), 'keep');
  assert.deepEqual(fs.readdirSync(path.dirname(target)).sort(), ['Pressable.js', path.basename(sibling)].sort());
});

test('existing transaction lock is preserved', t => {
  const { dir, target } = fixture(t);
  fs.writeFileSync(target + '.repair.lock', 'other owner');
  assert.throws(() => repair(dir), /EEXIST/);
  assert.equal(fs.readFileSync(target, 'utf8'), pristine);
  assert.equal(fs.readFileSync(target + '.repair.lock', 'utf8'), 'other owner');
});

for (const operation of ['writeFileSync', 'fsyncSync']) test('failed ' + operation + ' leaves no partial publication', t => {
  const { dir, target } = fixture(t);
  const original = fs[operation];
  t.mock.method(fs, operation, (destination, ...args) => {
    if (typeof destination === 'number') throw Error('injected staging failure');
    return original(destination, ...args);
  });
  assert.throws(() => repair(dir), /injected staging failure/);
  assert.equal(fs.readFileSync(target, 'utf8'), pristine);
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ['Pressable.js']);
});

test('node_modules file is an invalid install rather than an absent install', t => {
  const { dir } = fixture(t, false);
  fs.writeFileSync(path.join(dir, 'node_modules'), 'invalid');
  assert.throws(() => repair(dir), /node_modules/);
});

for (const change of ['source', 'version']) test('concurrent ' + change + ' edit aborts publication', t => {
  const { dir, pkg, target } = fixture(t);
  const write = fs.writeFileSync;
  let changed = false;
  t.mock.method(fs, 'writeFileSync', (destination, ...args) => {
    const result = write(destination, ...args);
    if (!changed && typeof destination === 'number') {
      changed = true;
      write(change === 'source' ? target : path.join(pkg, 'package.json'),
        change === 'source' ? pristine + '\nexternal edit\n' : '{"version":"0.86.4"}');
    }
    return result;
  });
  assert.throws(() => repair(dir), /changed before publication|version/);
  assert.equal(fs.readFileSync(target, 'utf8'), change === 'source' ? pristine + '\nexternal edit\n' : pristine);
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ['Pressable.js']);
});

test('postinstall owner invokes Pressable repair after whisper guard and aborts downstream work on failure', () => {
  const owner = fs.readFileSync(path.join(root, 'scripts/patch-react-native-gradle.js'), 'utf8');
  for (const failing of [false, true]) {
    const calls = [];
    const stubRequire = name => name === 'node:path' || name === 'path' ? path : new Proxy({}, {
      get: (_, key) => dir => {
        calls.push([key, path.resolve(dir)]);
        if (failing && key === 'repairPressableAccessibility') throw Error('repair rejected');
      },
    });
    const module = { filename: path.join(root, 'scripts/patch-react-native-gradle.js'), exports: {} };
    stubRequire.main = module;
    const run = () => new Function('require', 'module', owner)(stubRequire, module);
    if (failing) assert.throws(run, /repair rejected/); else run();
    assert.equal(calls[0]?.[0], 'patchWhisperWordBoundaries');
    assert.equal(calls[1]?.[0], 'repairPressableAccessibility');
    assert.ok(calls.every(([, dir]) => dir === path.resolve(root)));
    if (failing) assert.equal(calls.length, 2);
    else assert.deepEqual(calls.map(([name]) => name), ['patchWhisperWordBoundaries', 'repairPressableAccessibility', 'repairNativeScrollInput',
      'repairReanimatedNativeProps', 'patchAndroidDependencies', 'configureAndroidRelease']);
  }
});
