'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const hash = value => createHash('sha256').update(value).digest('hex');
// Inspect every ancestor as well as the leaf: lstat rejects Windows junctions too.
// No writes are made while discovering or validating the package.
function inspect(file, directory = false) {
  const absolute = path.resolve(file);
  const root = path.parse(absolute).root;
  let current = root;
  const parts = path.relative(root, absolute).split(path.sep).filter(Boolean);
  const paths = [root];
  for (const part of parts) { current = path.join(current, part); paths.push(current); }
  let stat;
  for (let i = 0; i < paths.length; i++) {
    stat = fs.lstatSync(paths[i]);
    if (stat.isSymbolicLink()) throw Error('Link/reparse path rejected: ' + paths[i]);
    const isDirectory = i < paths.length - 1 || directory;
    if (isDirectory ? !stat.isDirectory() : !stat.isFile()) {
      throw Error('Unexpected file type: ' + paths[i]);
    }
    if (!isDirectory && stat.nlink !== 1) throw Error('Hard link rejected: ' + paths[i]);
  }
  return stat;
}

// Returns true only on publication, false only for the exact approved bytes.
// Internal to the two pinned RN source repairs; caller supplies the project root.
function repairReactNativeSource(projectRoot, { relative, beforeHash, afterHash, label, prepare }) {
  if (typeof projectRoot !== 'string' || !projectRoot) throw Error('Explicit project root required');
  const pkg = path.resolve(projectRoot, 'node_modules', 'react-native');
  const metadata = path.join(pkg, 'package.json');
  const target = path.join(pkg, relative);
  function checkVersion() {
    inspect(metadata);
    const { version } = JSON.parse(fs.readFileSync(metadata, 'utf8'));
    if (version !== '0.86.3') throw Error('Unsupported React Native version: ' + version);
  }
  function readTarget() {
    const stat = inspect(target);
    return { bytes: fs.readFileSync(target), stat };
  }
  checkVersion();
  const original = readTarget();
  const digest = hash(original.bytes);
  if (digest !== beforeHash && digest !== afterHash) throw Error('Unknown ' + label + ' source/hash');
  if (digest === afterHash) return false;

  const repaired = prepare(original.bytes);
  if (!Buffer.isBuffer(repaired) || hash(repaired) !== afterHash) {
    throw Error('Unexpected repaired ' + label + ' hash');
  }

  function checkUnchanged() {
    checkVersion();
    const now = readTarget();
    if (now.stat.dev !== original.stat.dev || now.stat.ino !== original.stat.ino ||
        now.stat.mode !== original.stat.mode || now.stat.mtimeMs !== original.stat.mtimeMs ||
        now.stat.ctimeMs !== original.stat.ctimeMs || hash(now.bytes) !== beforeHash) {
      throw Error(label + ' source changed before publication');
    }
  }
  checkUnchanged();
  const lock = target + '.repair.lock';
  const temporary = target + '.' + randomUUID() + '.tmp';
  const lockFd = fs.openSync(lock, 'wx');
  let temporaryOwned = false;
  try {
    checkUnchanged();
    const fd = fs.openSync(temporary, 'wx', original.stat.mode);
    temporaryOwned = true;
    try {
      fs.writeFileSync(fd, repaired);
      fs.fchmodSync(fd, original.stat.mode);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    inspect(temporary);
    if (hash(fs.readFileSync(temporary)) !== afterHash) throw Error('Staged ' + label + ' hash mismatch');
    checkUnchanged();
    // Same-directory rename publishes complete bytes; no unlink or in-place overwrite fallback.
    fs.renameSync(temporary, target);
    temporaryOwned = false;
    return true;
  } finally {
    try {
      if (temporaryOwned) fs.unlinkSync(temporary);
    } finally {
      try { fs.closeSync(lockFd); }
      finally { fs.unlinkSync(lock); }
    }
  }
}

module.exports = { repairReactNativeSource };
