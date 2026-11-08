const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const hash = data => createHash('sha256').update(data).digest('hex');
const beforeHash = '695979b30215b0ad22e4801c4359a4c2cf27457a7fefce3422397ab56620c6ae';
const afterHash = '79fc202074ed52f395429b980d507bff7d896d6edab54b02904af3d17cf92371';
const before = 'if (this.path.startsWith("facebook-hermes-")) {';
const after = 'if (this.path.startsWith("facebook-hermes-") || this.path.startsWith("meta-hermes-")) {';

// RN 0.86.3's pinned Hermes source now redirects to meta/hermes. Only the
// archive root is flattened; versions, download URLs and all build flags stay.
function repairHermesSourceLayout(root) {
  const pkg = path.resolve(root, 'node_modules/react-native');
  const metadata = path.join(pkg, 'package.json');
  const target = path.join(pkg, 'ReactAndroid/hermes-engine/build.gradle.kts');
  const read = file => {
    for (let part = path.resolve(file); ; part = path.dirname(part)) {
      if (fs.lstatSync(part).isSymbolicLink()) throw Error('Linked Hermes input');
      if (path.dirname(part) === part) break;
    }
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1) throw Error('Invalid Hermes input');
    return fs.readFileSync(file);
  };
  const version = () => {
    if (JSON.parse(read(metadata)).version !== '0.86.3') throw Error('Unsupported RN version');
  };
  version();
  const source = read(target);
  const digest = hash(source);
  if (digest === afterHash) return false;
  if (digest !== beforeHash) throw Error('Unknown Hermes build source');
  const output = source.toString('utf8').replace(before, after);
  if (hash(output) !== afterHash) throw Error('Unexpected Hermes repair');
  const lock = target + '.repair.lock';
  const fd = fs.openSync(lock, 'wx');
  const staged = target + '.' + randomUUID() + '.tmp';
  let owned = false;
  try {
    const stagedFd = fs.openSync(staged, 'wx', fs.statSync(target).mode);
    owned = true;
    try { fs.writeFileSync(stagedFd, output); fs.fsyncSync(stagedFd); }
    finally { fs.closeSync(stagedFd); }
    version();
    if (hash(read(target)) !== beforeHash) throw Error('Hermes source changed before publication');
    fs.renameSync(staged, target);
    owned = false;
    return true;
  } finally {
    try { if (owned) fs.unlinkSync(staged); }
    finally { fs.closeSync(fd); fs.unlinkSync(lock); }
  }
}
module.exports = { repairHermesSourceLayout };
if (require.main === module) repairHermesSourceLayout(path.resolve(__dirname, '../..'));
