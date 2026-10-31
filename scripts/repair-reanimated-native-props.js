'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spliceMap } = require('./reanimated-native-props-map');
const TS = 'src/platformFunctions/setNativeProps.ts';
const JS = 'lib/module/platformFunctions/setNativeProps.js';
const MAP = JS + '.map';
// Public 4.5.1 package, lock-integrity verified by delivery-repair-candidate
// provenance.json (tar SHA256 92ef1dba...0186f). No other version/bytes accepted.
const hashes = {
  [TS]: ['715fd88324a37bdd528f85a4ee2dee34c37734968ee0f8705818445bc7f31fa0', 'd5dc66681313d156fa4bb024f8a81203e11b1529b40fcaae6cc87e28d9555acb'],
  [JS]: ['923e133e434c8b98ee3230d4d34da82b01d93795c870c903215be27dd820b5da', 'ab98e167c34d12220988a9916e05f3f8c42479332d1af5911d792a3af88b2149'],
  [MAP]: ['d8d97211ba415acde6413194b0355d0f6075a56de967313051b5e89e303d6f0e', '7d47d97553c5431d1db6a05a5f3d719eb8c49c07dcd4be1ac7a26d3f6c439dd1'],
};
const hash = value => createHash('sha256').update(value).digest('hex');
const flush = "  if (IS_ANDROID && !USE_ANIMATION_BACKEND) {\n    global._maybeFlushUIUpdatesQueue();\n  }\n";
const edits = {
  [TS]: [
    ['  IS_JEST,\n', '  IS_ANDROID,\n  IS_JEST,\n'],
    ['type SetNativeProps =', "import { getStaticFeatureFlag } from '../featureFlags';\n\nconst USE_ANIMATION_BACKEND = getStaticFeatureFlag('USE_ANIMATION_BACKEND');\n\ntype SetNativeProps ="],
    ['  global._updateProps!([{ shadowNodeWrapper, updates }]);\n', '  global._updateProps!([{ shadowNodeWrapper, updates }]);\n' + flush],
  ],
  [JS]: [
    ['import { IS_JEST,', 'import { IS_ANDROID, IS_JEST,'],
    ['/**\n', "import { getStaticFeatureFlag } from \"../featureFlags/index.js\";\nconst USE_ANIMATION_BACKEND = getStaticFeatureFlag('USE_ANIMATION_BACKEND');\n/**\n"],
    ['  }]);\n', '  }]);\n' + flush],
  ],
};
function substitute(text, before, after) {
  if (text.split(before).length !== 2) throw Error('Pinned substitution must match exactly once');
  return text.replace(before, after);
}
function repairPinned451({ version, files }) {
  if (version !== '4.5.1') throw Error('Unsupported Reanimated version: ' + version);
  if (!files || Object.keys(files).length !== 3 || Object.keys(files).some(p => !Object.hasOwn(hashes, p))) {
    throw Error('Expected exactly TS, module JS and module source map');
  }
  // Whole input preflight: a partly repaired known triple is recoverable, any
  // unknown byte (including the map) fails before returning a repair plan.
  for (const p of Object.keys(hashes)) {
    if (typeof files[p] !== 'string' || !hashes[p].includes(hash(files[p]))) throw Error('Unknown source/hash: ' + p);
  }
  const originals = {}, result = {};
  for (const p of [TS, JS]) {
    let text = files[p];
    if (hash(text) === hashes[p][1]) {
      for (const [before, after] of [...edits[p]].reverse()) text = substitute(text, after, before);
    }
    if (hash(text) !== hashes[p][0]) throw Error('Invalid reverse repair: ' + p);
    originals[p] = text;
    for (const [before, after] of edits[p]) text = substitute(text, before, after);
    result[p] = text;
  }
  const lineOf = (text, token) => text.slice(0, text.indexOf(token)).split('\n').length - 1;
  result[MAP] = hash(files[MAP]) === hashes[MAP][1] ? files[MAP] : spliceMap(files[MAP], [
    [lineOf(originals[TS], '  IS_JEST,'), 1],
    [lineOf(originals[TS], 'type SetNativeProps ='), 4],
    [lineOf(originals[TS], '  global._updateProps!') + 1, 3],
  ], [
    [lineOf(originals[JS], '/**'), 2],
    [lineOf(originals[JS], '  }]);') + 1, 3],
  ], lineOf(originals[JS], 'import { IS_JEST,'));
  for (const p of Object.keys(hashes)) {
    if (hash(result[p]) !== hashes[p][1]) throw Error('Unexpected repaired hash: ' + p);
  }
  return result;
}

// All-file preflight + staging precedes publication. Individual renames are
// atomic; rollback restores prior bytes on a caught I/O error. No filesystem
// offers a crash-atomic three-file rename: known partial states are deliberately
// accepted on recovery. A process crash leaves the exclusive lock for explicit
// recovery before rerunning. Never load/build this dependency during repair.
function repairPackage(packageRoot, { fs: io = fs } = {}) {
  const lock = path.join(packageRoot, '.reanimated-native-props-repair.lock');
  const lockFd = io.openSync(lock, 'wx');
  const staged = [], published = [];
  try {
    const read = p => {
      const stat = io.lstatSync(p);
      if (!stat.isFile() || stat.size > 65536) throw Error('Expected bounded regular file: ' + p);
      return io.readFileSync(p);
    };
    const metadata = read(path.join(packageRoot, 'package.json'));
    const { version } = JSON.parse(metadata.toString('utf8'));
    const files = Object.fromEntries(Object.keys(hashes).map(p => [p, read(path.join(packageRoot, p)).toString('utf8')]));
    const result = repairPinned451({ version, files });
    for (const p of Object.keys(hashes)) {
      if (result[p] === files[p]) continue;
      const target = path.join(packageRoot, p), nonce = randomUUID();
      const row = { target, temp: target + '.' + nonce + '.tmp', backup: target + '.' + nonce + '.bak' };
      staged.push(row);
      const mode = io.statSync(target).mode;
      io.writeFileSync(row.temp, result[p], { flag: 'wx', mode });
      io.writeFileSync(row.backup, files[p], { flag: 'wx', mode });
    }
    // Catch external edits after staging without replacing anybody else's bytes.
    if (!read(path.join(packageRoot, 'package.json')).equals(metadata)) throw Error('Package changed during repair');
    for (const p of Object.keys(hashes)) {
      if (!read(path.join(packageRoot, p)).equals(Buffer.from(files[p]))) throw Error('Source changed during repair: ' + p);
    }
    for (const row of staged) { io.renameSync(row.temp, row.target); published.push(row); }
    return { version, changed: staged.map(row => path.relative(packageRoot, row.target).split(path.sep).join('/')) };
  } catch (error) {
    const failures = [];
    for (const row of published.reverse()) {
      try { io.renameSync(row.backup, row.target); } catch (failure) { failures.push(failure); row.keepBackup = true; }
    }
    if (failures.length) throw new AggregateError([error, ...failures], 'Repair rollback failed; retained .bak files require recovery');
    throw error;
  } finally {
    for (const row of staged) for (const p of [row.temp, ...(row.keepBackup ? [] : [row.backup])]) {
      if (io.existsSync(p)) io.unlinkSync(p);
    }
    io.closeSync(lockFd);
    io.unlinkSync(lock);
  }
}
function repairReanimatedNativeProps(projectRoot) {
  // Preserve pre-install lifecycle only when the entire dependency tree is absent.
  // A present but incomplete tree is an error, never a silently skipped repair.
  try { fs.lstatSync(path.join(projectRoot, 'node_modules')); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  return repairPackage(path.join(projectRoot, 'node_modules', 'react-native-reanimated'));
}
module.exports = { repairPinned451, repairPackage, repairReanimatedNativeProps };
if (require.main === module) {
  try { console.log(repairReanimatedNativeProps(path.resolve(__dirname, '..'))); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
