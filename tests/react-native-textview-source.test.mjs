import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const relative = 'ReactAndroid/src/main/java/com/facebook/react/views/text/ReactTextView.java';
const beforeHash = 'f6854ff6811b1ead2c93edbe7ae740ac76de78782478bcc2e07f73457a1ab99d';
const afterHash = 'c6621b5224ab4cb980d36dc0c6bca5ae58c84f0bf79e0b3b2a1c2b69439d760a';
const hash = b => createHash('sha256').update(b).digest('hex');
const original = fs.readFileSync(path.join(__dirname, 'fixtures/rn-textview-before.java'));
const approved = fs.readFileSync(path.join(__dirname, 'fixtures/rn-textview-approved.java'));
assert.equal(hash(original), beforeHash);
assert.equal(hash(approved), afterHash);
const repair = root => {
  let installer;
  try { installer = require('../scripts/react-native-fontfit/repair-textview-source.cjs'); }
  catch (error) {
    if (error.code === 'MODULE_NOT_FOUND') throw Error('Installer absent');
    throw error;
  }
  return installer.repairTextViewSource(root);
};
function fixture(t, bytes = original, version = '0.86.3') {
  const root = fs.mkdtempSync(path.join(__dirname, '.fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pkg = path.join(root, 'node_modules/react-native');
  const target = path.join(pkg, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const metadata = path.join(pkg, 'package.json');
  fs.writeFileSync(metadata, JSON.stringify({ name: 'react-native', version }));
  fs.writeFileSync(target, bytes);
  return { root, pkg, target, metadata };
}
function noDebris(f) {
  assert.deepEqual(fs.readdirSync(path.dirname(f.target)), ['ReactTextView.java']);
}
function rejectsUntouched(f, pattern) {
  const bytes = fs.readFileSync(f.target);
  const stat = fs.statSync(f.target);
  assert.throws(() => repair(f.root), pattern);
  assert.deepEqual(fs.readFileSync(f.target), bytes);
  assert.equal(fs.statSync(f.target).mtimeMs, stat.mtimeMs);
  noDebris(f);
}
test('original installs exact approved bytes and preserves every gap between changed chunks', t => {
  const f = fixture(t);
  assert.equal(repair(f.root), true);
  const result = fs.readFileSync(f.target);
  assert.deepEqual(result, approved);
  assert.equal(hash(result), afterHash);
  const chunks = JSON.parse(fs.readFileSync(path.resolve(__dirname,
    '../scripts/react-native-fontfit/textview-chunks.json'), 'utf8'));
  assert.equal(chunks.length, 10);
  let oldEnd = 0, newEnd = 0;
  for (const chunk of chunks) {
    const before = Buffer.from(chunk.before, 'utf8');
    const after = Buffer.from(chunk.after, 'utf8');
    assert.equal(hash(before), chunk.beforeSha256);
    assert.equal(hash(after), chunk.afterSha256);
    const gap = chunk.offset - oldEnd;
    assert.ok(gap >= 0);
    assert.deepEqual(result.subarray(newEnd, newEnd + gap), original.subarray(oldEnd, chunk.offset));
    newEnd += gap;
    assert.deepEqual(original.subarray(chunk.offset, chunk.offset + before.length), before);
    assert.deepEqual(result.subarray(newEnd, newEnd + after.length), after);
    oldEnd = chunk.offset + before.length;
    newEnd += after.length;
  }
  assert.deepEqual(result.subarray(newEnd), original.subarray(oldEnd));
  noDebris(f);
});

test('repeat invocation does not rewrite or republish', t => {
  const f = fixture(t);
  repair(f.root);
  const stat = fs.statSync(f.target);
  for (let i = 0; i < 3; i++) assert.equal(repair(f.root), false);
  assert.deepEqual(fs.readFileSync(f.target), approved);
  assert.equal(fs.statSync(f.target).mtimeMs, stat.mtimeMs);
  assert.equal(fs.statSync(f.target).ino, stat.ino);
  noDebris(f);
});
test('already approved is accepted without rewrite', t => {
  const f = fixture(t, approved);
  const stat = fs.statSync(f.target);
  assert.equal(repair(f.root), false);
  assert.equal(fs.statSync(f.target).mtimeMs, stat.mtimeMs);
  noDebris(f);
});
for (const version of ['0.86.2', '0.86.3-canary.1', '0.86.30', undefined]) {
  test('reject version ' + String(version) + ' before writing', t => {
    const f = fixture(t);
    fs.writeFileSync(f.metadata, JSON.stringify({ version }));
    rejectsUntouched(f, /version/i);
  });
}
test('approved source still requires exact version', t => {
  rejectsUntouched(fixture(t, approved, '0.86.4'), /version/i);
});
for (const [name, bytes] of [
  ['outside-body change', Buffer.concat([original, Buffer.from('// unknown\n')])],
  ['inside changed chunk', Buffer.from(original.toString().replace('            spanned,', '            spanned, // changed'))],
  ['CRLF normalization', Buffer.from(original.toString().replace(/\n/g, '\r\n'))],
  ['empty input', Buffer.alloc(0)],
]) {
  test('reject unknown ' + name + ' untouched', t => rejectsUntouched(fixture(t, bytes), /hash|source/i));
}
test('invalid package JSON is untouched', t => {
  const f = fixture(t);
  fs.writeFileSync(f.metadata, '{broken');
  rejectsUntouched(f, /JSON|property|Unexpected/i);
});
test('missing target does not create it', t => {
  const f = fixture(t);
  fs.unlinkSync(f.target);
  assert.throws(() => repair(f.root), /ENOENT|missing/i);
  assert.deepEqual(fs.readdirSync(path.dirname(f.target)), []);
});
test('lock contention does not modify source or remove another lock', t => {
  const f = fixture(t);
  const lock = f.target + '.repair.lock';
  fs.writeFileSync(lock, 'owner');
  assert.throws(() => repair(f.root), /EEXIST|lock/i);
  assert.deepEqual(fs.readFileSync(f.target), original);
  assert.equal(fs.readFileSync(lock, 'utf8'), 'owner');
});
for (const which of ['source', 'metadata', 'package', 'modules', 'root']) {
  test('reject ' + which + ' symbolic link or junction without following writes', t => {
    const f = fixture(t);
    const p = which === 'source' ? f.target : which === 'metadata' ? f.metadata : which === 'package' ? f.pkg : which === 'modules' ? path.join(f.root, 'node_modules') : f.root;
    const moved = p + '.real';
    fs.renameSync(p, moved);
    if (which === 'root') t.after(() => fs.rmSync(moved, { recursive: true, force: true }));
    // Exercise real OS links where available; model lstat for file links only when
    // Windows denies their creation. Directory junction cases always use the OS.
    try {
      fs.symlinkSync(moved, p, ['source', 'metadata'].includes(which) ? 'file' : process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (process.platform !== 'win32' || error.code !== 'EPERM' || !['source', 'metadata'].includes(which)) throw error;
      fs.renameSync(moved, p);
      t.diagnostic('Windows EPERM creating file symlink; modeled lstat link flag, real directory junctions tested separately');
      const lstat = fs.lstatSync;
      fs.lstatSync = (file, ...args) => {
        const stat = lstat(file, ...args);
        if (path.resolve(file) === p) stat.isSymbolicLink = () => true;
        return stat;
      };
      try { assert.throws(() => repair(f.root), /link|reparse/i); }
      finally { fs.lstatSync = lstat; }
      assert.deepEqual(fs.readFileSync(f.target), original);
      noDebris(f);
      return;
    }
    assert.throws(() => repair(f.root), /link|reparse/i);
    assert.deepEqual(fs.readFileSync(f.target), original);
  });
}
test('reject source hard link without modifying either name', t => {
  const f = fixture(t);
  const alias = path.join(f.root, 'alias.java');
  fs.linkSync(f.target, alias);
  rejectsUntouched(f, /link/i);
  assert.deepEqual(fs.readFileSync(alias), original);
});
test('failed atomic publication leaves original and cleans owned artifacts', t => {
  const f = fixture(t);
  const rename = fs.renameSync;
  fs.renameSync = (...args) => {
    if (args[1] === f.target) {
      assert.deepEqual(fs.readFileSync(f.target), original);
      assert.deepEqual(fs.readFileSync(args[0]), approved);
      throw Error('injected publication failure');
    }
    return rename(...args);
  };
  try { rejectsUntouched(f, /injected publication failure/); }
  finally { fs.renameSync = rename; }
});
test('version changed after staging prevents publication and cleans artifacts', t => {
  const f = fixture(t);
  const sync = fs.fsyncSync;
  fs.fsyncSync = fd => {
    sync(fd);
    fs.writeFileSync(f.metadata, JSON.stringify({ version: '0.86.4' }));
  };
  try { rejectsUntouched(f, /version/i); }
  finally { fs.fsyncSync = sync; }
});
test('source changed after staging is preserved rather than overwritten', t => {
  const f = fixture(t);
  const changed = Buffer.concat([original, Buffer.from('// concurrent writer\n')]);
  const sync = fs.fsyncSync;
  fs.fsyncSync = fd => { sync(fd); fs.writeFileSync(f.target, changed); };
  try {
    assert.throws(() => repair(f.root), /changed|hash|source/i);
    assert.deepEqual(fs.readFileSync(f.target), changed);
    noDebris(f);
  } finally { fs.fsyncSync = sync; }
});

for (const mutation of ['offset', 'before', 'after', 'beforeSha256', 'afterSha256', 'order']) {
  test('invalid chunk ' + mutation + ' fails without publication', t => {
    const f = fixture(t);
    const read = fs.readFileSync;
    fs.readFileSync = (file, ...args) => {
      const bytes = read(file, ...args);
      if (typeof file !== 'string' || !file.endsWith('textview-chunks.json')) return bytes;
      const chunks = JSON.parse(bytes);
      if (mutation === 'order') chunks.reverse();
      else if (mutation === 'offset') chunks[0].offset++;
      else chunks[0][mutation] += 'x';
      return JSON.stringify(chunks);
    };
    try { rejectsUntouched(f, /chunk|hash|payload/i); }
    finally { fs.readFileSync = read; }
  });
}

test('same-byte source replacement after staging is not overwritten', t => {
  const f = fixture(t);
  const sync = fs.fsyncSync;
  let replaced;
  fs.fsyncSync = fd => {
    sync(fd);
    const other = path.join(f.root, 'replacement.java');
    fs.writeFileSync(other, original);
    fs.renameSync(other, f.target);
    replaced = fs.statSync(f.target);
  };
  try {
    assert.throws(() => repair(f.root), /changed/i);
    assert.deepEqual(fs.readFileSync(f.target), original);
    assert.equal(fs.statSync(f.target).ino, replaced.ino);
    noDebris(f);
  } finally { fs.fsyncSync = sync; }
});

test('corrupt staged bytes are rejected and cleaned', t => {
  const f = fixture(t);
  const write = fs.writeFileSync;
  fs.writeFileSync = (file, bytes, ...args) => write(file,
    typeof file === 'number' ? Buffer.concat([bytes, Buffer.from('corrupt')]) : bytes, ...args);
  try { rejectsUntouched(f, /staged.*hash/i); }
  finally { fs.writeFileSync = write; }
});

test('metadata hard link is rejected', t => {
  const f = fixture(t);
  const alias = path.join(f.root, 'package-alias.json');
  fs.linkSync(f.metadata, alias);
  rejectsUntouched(f, /link/i);
  assert.deepEqual(fs.readFileSync(alias), fs.readFileSync(f.metadata));
});

test('explicit project root is required', () => {
  for (const root of [undefined, null, '', 12]) assert.throws(() => repair(root), /root/i);
});
