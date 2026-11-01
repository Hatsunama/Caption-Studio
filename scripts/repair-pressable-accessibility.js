'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const relative = 'Libraries/Components/Pressable/Pressable.js';
const beforeHash = '3e6c095cd9c51cb982236bc2bf19e1bee84f709b09c3187f36c594086894457d';
const afterHash = '14e0c2e0d9a52a51d4401f85c5f360030c348517ddf4bb597ea3d114d6f719d6';
const before = 'disabled: ariaDisabled ?? accessibilityState?.disabled,';
const after = 'disabled: ariaDisabled ?? accessibilityState?.disabled ?? false,';
const hash = value => createHash('sha256').update(value).digest('hex');

// RN 0.86.3: keep the native state boolean for the documented enabled default.
// Preserve ARIA/state priority, the later explicit disabled override, and input config.
function repairPressableAccessibility(projectRoot) {
  const modules = path.resolve(projectRoot, 'node_modules');
  try {
    fs.lstatSync(modules);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (!fs.statSync(modules).isDirectory()) throw Error('Invalid node_modules directory');
  const pkg = path.join(modules, 'react-native');
  const checkVersion = () => {
    const { version } = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8'));
    if (version !== '0.86.3') throw Error('Unsupported React Native version: ' + version);
  };
  checkVersion();
  const target = path.join(pkg, relative);
  const original = fs.readFileSync(target);
  const digest = hash(original);
  if (digest !== beforeHash && digest !== afterHash) throw Error('Unknown Pressable source/hash');
  if (digest === afterHash) return false;
  const text = original.toString('utf8');
  if (text.split(before).length !== 2) throw Error('Pinned replacement must match exactly once');
  const repaired = text.replace(before, after);
  if (hash(repaired) !== afterHash) throw Error('Unexpected repaired Pressable hash');
  const lock = target + '.repair.lock';
  const temporary = target + '.' + randomUUID() + '.tmp';
  const lockFd = fs.openSync(lock, 'wx');
  let temporaryOwned = false;
  try {
    checkVersion();
    if (hash(fs.readFileSync(target)) !== beforeHash) throw Error('Pressable source changed before write');
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
    if (hash(fs.readFileSync(target)) !== beforeHash) throw Error('Pressable source changed before publication');
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

module.exports = { repairPressableAccessibility };
