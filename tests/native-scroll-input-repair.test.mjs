import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
const relative = 'android/src/main/java/com/swmansion/gesturehandler/core/NativeViewGestureHandler.kt';
const beforeHash = 'bbd4f3e20abb24738a94ab849e62498fed576ef4593fec6b946d1c1b5da317f1';
const afterHash = '2d7aeb45f1631c7b40dab6e5cf16e78e598e8fd9bff4dfa40df8b6c960038a74';
const hash = value => createHash('sha256').update(value).digest('hex');
const before = '    private fun tryIntercept(view: View, event: MotionEvent) = view is ViewGroup && view.onInterceptTouchEvent(event)';
const after = `    private fun tryIntercept(view: View, event: MotionEvent): Boolean {
      val intercepted = view is ViewGroup && view.onInterceptTouchEvent(event)
      if (intercepted && (view is ReactScrollView || view is ReactHorizontalScrollView)) {
        view.cancelPendingInputEvents()
      }
      return intercepted
    }`;
const sourceRoot = process.env.RNGH_SOURCE_ROOT || path.join(root, 'node_modules/react-native-gesture-handler');
assert.equal(JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'))).version, '2.32.0');
let pristine = fs.readFileSync(path.join(sourceRoot, relative), 'utf8');
if (hash(pristine) === afterHash) {
  assert.equal(pristine.split(after).length, 2);
  pristine = pristine.replace(after, before);
}
assert.equal(hash(pristine), beforeHash, 'fixtures require exact known installed source');
const { repairNativeScrollInput } = require('../scripts/repair-native-scroll-input.js');

function fixture(t, installed = true) {
  const dir = fs.mkdtempSync(path.join(root, '.native-scroll-input-test-'));
  t.after(() => {
    assert.ok(path.resolve(dir).startsWith(path.join(root, '.native-scroll-input-test-')));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const pkg = path.join(dir, 'node_modules/react-native-gesture-handler');
  const target = path.join(pkg, relative);
  if (installed) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ version: '2.32.0' }));
    fs.writeFileSync(target, pristine);
  }
  return { dir, pkg, target };
}

test('source contract: pristine fails cancellation guard, repair passes with only the pinned replacement', t => {
  const { dir, target } = fixture(t);
  // Textual contract only: Android runtime verification belongs to the device regression.
  const guard = source => assert.ok(source.includes(after));
  assert.throws(() => guard(pristine), assert.AssertionError);
  assert.equal(repairNativeScrollInput(dir), true);
  const repaired = fs.readFileSync(target, 'utf8');
  guard(repaired);
  assert.equal(repaired, pristine.replace(before, after));
  assert.equal(hash(repaired), afterHash);
});

test('idempotence preserves bytes, permissions and mtime on second call', t => {
  const { dir, target } = fixture(t);
  fs.chmodSync(target, 0o640);
  const mode = fs.statSync(target).mode;
  assert.equal(repairNativeScrollInput(dir), true);
  assert.equal(fs.statSync(target).mode, mode);
  const stamp = fs.statSync(target).mtimeMs;
  assert.equal(repairNativeScrollInput(dir), false);
  assert.equal(fs.statSync(target).mtimeMs, stamp);
  assert.equal(hash(fs.readFileSync(target)), afterHash);
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ['NativeViewGestureHandler.kt']);
});

test('unknown bytes and versions fail before any write', t => {
  for (const version of ['2.32.1', '3.4.0', undefined]) {
    const { dir, pkg, target } = fixture(t);
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ version }));
    assert.throws(() => repairNativeScrollInput(dir), /version/i);
    assert.equal(fs.readFileSync(target, 'utf8'), pristine);
    assert.deepEqual(fs.readdirSync(path.dirname(target)), ['NativeViewGestureHandler.kt']);
  }
  const { dir, target } = fixture(t);
  fs.appendFileSync(target, '\n');
  assert.throws(() => repairNativeScrollInput(dir), /hash|source/i);
  assert.equal(fs.readFileSync(target, 'utf8'), pristine + '\n');
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ['NativeViewGestureHandler.kt']);
});

test('only entirely absent node_modules is a no-op; incomplete installs fail closed', t => {
  const { dir, pkg, target } = fixture(t, false);
  assert.equal(repairNativeScrollInput(dir), false);
  assert.deepEqual(fs.readdirSync(dir), []);
  fs.mkdirSync(path.join(dir, 'node_modules'));
  assert.throws(() => repairNativeScrollInput(dir));
  fs.mkdirSync(pkg);
  assert.throws(() => repairNativeScrollInput(dir));
  fs.writeFileSync(path.join(pkg, 'package.json'), '{');
  assert.throws(() => repairNativeScrollInput(dir));
  fs.writeFileSync(path.join(pkg, 'package.json'), '{"version":"2.32.0"}');
  assert.throws(() => repairNativeScrollInput(dir));
  assert.equal(fs.existsSync(target), false);
});

test('node_modules file is an invalid install, not an absent lifecycle', t => {
  const { dir } = fixture(t, false);
  fs.writeFileSync(path.join(dir, 'node_modules'), 'invalid');
  assert.throws(() => repairNativeScrollInput(dir), /node_modules/);
});

test('failed atomic rename preserves original and cleans only owned files', t => {
  const { dir, target } = fixture(t);
  const sibling = target + '.someone-else.tmp';
  fs.writeFileSync(sibling, 'keep');
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === target) throw new Error('injected rename failure');
    return rename(from, to);
  });
  assert.throws(() => repairNativeScrollInput(dir), /injected rename failure/);
  assert.equal(fs.readFileSync(target, 'utf8'), pristine);
  assert.equal(fs.readFileSync(sibling, 'utf8'), 'keep');
  assert.deepEqual(fs.readdirSync(path.dirname(target)).sort(), ['NativeViewGestureHandler.kt', path.basename(sibling)].sort());
});

test('exclusive lock refuses concurrent ownership without deleting the other lock', t => {
  const { dir, target } = fixture(t);
  fs.writeFileSync(target + '.repair.lock', 'other owner');
  assert.throws(() => repairNativeScrollInput(dir), /EEXIST/);
  assert.equal(fs.readFileSync(target, 'utf8'), pristine);
  assert.equal(fs.readFileSync(target + '.repair.lock', 'utf8'), 'other owner');
});

test('an external source edit during staging is preserved instead of overwritten', t => {
  const { dir, target } = fixture(t);
  const write = fs.writeFileSync;
  let edited = false;
  t.mock.method(fs, 'writeFileSync', (destination, ...args) => {
    const result = write(destination, ...args);
    if (!edited && typeof destination === 'number') {
      edited = true;
      write(target, pristine + '\nexternal edit\n');
    }
    return result;
  });
  assert.throws(() => repairNativeScrollInput(dir), /changed before publication/);
  assert.equal(fs.readFileSync(target, 'utf8'), pristine + '\nexternal edit\n');
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ['NativeViewGestureHandler.kt']);
});
