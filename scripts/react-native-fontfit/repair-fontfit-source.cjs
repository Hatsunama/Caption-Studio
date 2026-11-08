'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const beforeHash = '6dd95802eae01819bc96c64f920eab119c3dbac20a659e3ad8ef602eba47caf8';
const afterHash = '28dc610fbb2db06fc71a57af7a4d85b3c9c741c15153843986d313c034172763';
const relative = 'ReactAndroid/src/main/java/com/facebook/react/views/text/TextLayoutManager.kt';
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
// Like repair-pressable-accessibility.js, caller supplies the project root.
function repairFontFitSource(projectRoot) {
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
  if (digest !== beforeHash && digest !== afterHash) throw Error('Unknown fitter source/hash');
  if (digest === afterHash) return false;

  const guard = JSON.parse(fs.readFileSync(path.join(__dirname, 'scope-guard.json'), 'utf8'));
  const body = fs.readFileSync(path.join(__dirname, 'adjustSpannableFontToFit.body.kt'));
  const { bodyOffset: start, originalBodyBytes: length } = guard;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0 ||
      start + length > original.bytes.length || hash(body) !== guard.replacementBodySha256) {
    throw Error('Invalid fitter body payload/guard');
  }
  // Buffer slicing preserves all bytes, including signature, imports and line endings.
  const repaired = Buffer.concat([original.bytes.subarray(0, start), body, original.bytes.subarray(start + length)]);
  if (hash(repaired) !== afterHash) throw Error('Unexpected repaired fitter hash');

  function checkUnchanged() {
    checkVersion();
    const now = readTarget();
    if (now.stat.dev !== original.stat.dev || now.stat.ino !== original.stat.ino ||
        now.stat.mode !== original.stat.mode || now.stat.mtimeMs !== original.stat.mtimeMs ||
        now.stat.ctimeMs !== original.stat.ctimeMs || hash(now.bytes) !== beforeHash) {
      throw Error('Fitter source changed before publication');
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
    if (hash(fs.readFileSync(temporary)) !== afterHash) throw Error('Staged fitter hash mismatch');
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

module.exports = { repairFontFitSource };
if (require.main === module) {
  if (process.argv.length !== 3) {
    console.error('Usage: node repair-fontfit-source.cjs <project-root>');
    process.exitCode = 1;
  } else {
    try { console.log(repairFontFitSource(process.argv[2]) ? 'Font fitter source repaired' : 'Font fitter source already approved'); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
