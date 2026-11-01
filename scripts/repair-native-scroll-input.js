'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
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

// RNGH 2.32.0 sends intercepted events via onTouchEvent, bypassing child
// cancellation in ViewGroup.dispatchTouchEvent. Cancel pending scroll-child input.
function repairNativeScrollInput(projectRoot) {
  const modules = path.resolve(projectRoot, 'node_modules');
  try {
    fs.lstatSync(modules);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (!fs.statSync(modules).isDirectory()) throw Error('Invalid node_modules directory');
  const pkg = path.join(modules, 'react-native-gesture-handler');
  const checkVersion = () => {
    const { version } = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8'));
    if (version !== '2.32.0') throw Error('Unsupported RNGH version: ' + version);
  };
  checkVersion();
  const target = path.join(pkg, relative);
  const original = fs.readFileSync(target);
  const digest = hash(original);
  if (digest !== beforeHash && digest !== afterHash) throw Error('Unknown RNGH source/hash');
  if (digest === afterHash) return false;
  const text = original.toString('utf8');
  if (text.split(before).length !== 2) throw Error('Pinned replacement must match exactly once');
  const repaired = text.replace(before, after);
  if (hash(repaired) !== afterHash) throw Error('Unexpected repaired RNGH hash');
  const lock = target + '.repair.lock';
  const temporary = target + '.' + randomUUID() + '.tmp';
  const lockFd = fs.openSync(lock, 'wx');
  let temporaryOwned = false;
  try {
    checkVersion();
    if (hash(fs.readFileSync(target)) !== beforeHash) throw Error('RNGH source changed before write');
    const mode = fs.statSync(target).mode;
    const fd = fs.openSync(temporary, 'wx', mode);
    temporaryOwned = true;
    try {
      fs.writeFileSync(fd, repaired);
      fs.fchmodSync(fd, mode);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    checkVersion();
    if (hash(fs.readFileSync(target)) !== beforeHash) throw Error('RNGH source changed before publication');
    fs.renameSync(temporary, target);
    temporaryOwned = false;
    return true;
  } finally {
    try {
      if (temporaryOwned) fs.unlinkSync(temporary);
    } finally {
      fs.closeSync(lockFd);
      fs.unlinkSync(lock);
    }
  }
}

module.exports = { repairNativeScrollInput };
