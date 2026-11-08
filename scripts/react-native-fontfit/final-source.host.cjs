'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
// Deliberately required before fixtures: initial failure must be missing installer only.
const { installFinalSources } = require('./install-final-sources.cjs');
const manifest = require('./source-manifest.json');
const payload = require('./source-chunks.json');
const sha = b => createHash('sha256').update(b).digest('hex');
const originals = manifest.files.map(f => {
  const bytes = fs.readFileSync(path.resolve(__dirname, '../../node_modules/react-native', f.relative));
  assert.equal(sha(bytes), f.beforeSha256, 'Run tooling tests on the clean locked dependency before source installation');
  return bytes;
});
// Expected whole-file digests were independently reviewed against actual candidate sources.
const applyChunks = (bytes, chunks) => {
  const parts = []; let cursor = 0;
  for (const c of chunks) { parts.push(bytes.subarray(cursor, c.offset), Buffer.from(c.replacementUtf8)); cursor = c.offset + c.length; }
  parts.push(bytes.subarray(cursor)); return Buffer.concat(parts);
};
const finals = payload.map((f, i) => applyChunks(originals[i], f.chunks));
function fixture(t, states = [], version = '0.86.3') {
  const root = fs.mkdtempSync(path.join(__dirname, '.fixture-'));
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(__dirname + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const pkg = path.join(root, 'node_modules/react-native');
  const targets = manifest.files.map(f => path.join(pkg, f.relative));
  targets.forEach((p, i) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, states[i] === 'final' ? finals[i] : originals[i]); });
  const metadata = path.join(pkg, 'package.json');
  fs.writeFileSync(metadata, JSON.stringify({ name: 'react-native', version }));
  return { root, pkg, targets, metadata };
}
function snapshot(f) { return f.targets.map(p => ({ bytes: fs.readFileSync(p), stat: fs.statSync(p) })); }
function untouched(f, before) {
  f.targets.forEach((p, i) => {
    assert.deepEqual(fs.readFileSync(p), before[i].bytes);
    const s = fs.statSync(p);
    for (const key of ['ino', 'mtimeMs']) assert.equal(s[key], before[i].stat[key]);
  });
}
function noDebris(f) {
  const visit = p => { for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    assert.ok(!/\.tmp$|\.repair\.lock$/.test(e.name), e.name);
    if (e.isDirectory() && !e.isSymbolicLink()) visit(path.join(p, e.name));
  } };
  visit(f.pkg);
}
function rejects(t, change, pattern = /hash|source|version|link|JSON|ENOENT|type/i, states) {
  const f = fixture(t, states); change(f);
  const before = snapshot(f);
  assert.throws(() => installFinalSources(f.root), pattern);
  untouched(f, before); noDebris(f);
}
function patch(t, key, replacement) {
  const old = fs[key]; fs[key] = replacement(old); t.after(() => { fs[key] = old; });
}
test('pins, chunk hashes, independent originals/finals and unchanged byte regions', () => {
  assert.equal(manifest.reactNativeVersion, '0.86.3'); assert.equal(manifest.files.length, 5);
  assert.equal(payload.length, 5);
  payload.forEach((f, i) => {
    assert.equal(f.relative, manifest.files[i].relative);
    assert.equal(sha(originals[i]), f.beforeSha256); assert.equal(sha(finals[i]), f.afterSha256);
    let before = 0, after = 0;
    for (const c of f.chunks) {
      assert.equal(sha(originals[i].subarray(c.offset, c.offset + c.length)), c.beforeSha256);
      const replacement = Buffer.from(c.replacementUtf8);
      assert.equal(sha(replacement), c.afterSha256);
      const gap = c.offset - before;
      assert.ok(gap >= 0);
      assert.deepEqual(finals[i].subarray(after, after + gap), originals[i].subarray(before, c.offset));
      after += gap;
      assert.deepEqual(finals[i].subarray(after, after + replacement.length), replacement);
      before = c.offset + c.length; after += replacement.length;
    }
    assert.deepEqual(finals[i].subarray(after), originals[i].subarray(before));
  });
  assert.match(payload[0].beforeSha256, /^6dd958/);
  assert.match(payload[3].beforeSha256, /^f6854f/);
  for (const file of ['source-manifest.json', 'source-chunks.json'])
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, file), 'utf8'), /[A-Za-z]:[\\/]/);
});
test('all originals -> exact five finals, one atomic rename each', t => {
  const f = fixture(t); let publications = 0;
  patch(t, 'renameSync', rename => (from, to) => {
    const i = f.targets.indexOf(to);
    if (i >= 0) { assert.deepEqual(fs.readFileSync(to), originals[i]); assert.deepEqual(fs.readFileSync(from), finals[i]); publications++; }
    return rename(from, to);
  });
  assert.equal(installFinalSources(f.root), 5); assert.equal(publications, 5);
  f.targets.forEach((p, i) => assert.deepEqual(fs.readFileSync(p), finals[i])); noDebris(f);
});
test('all final idempotence preserves bytes, identity and time', t => {
  const f = fixture(t, Array(5).fill('final')); const before = snapshot(f);
  for (let i = 0; i < 3; i++) assert.equal(installFinalSources(f.root), 0);
  untouched(f, before); noDebris(f);
});
test('mixed final/original retry publishes only original states', t => {
  const f = fixture(t, ['final', 'original', 'final', 'original', 'final']); const before = snapshot(f);
  assert.equal(installFinalSources(f.root), 2);
  f.targets.forEach((p, i) => { assert.deepEqual(fs.readFileSync(p), finals[i]); if (i % 2 === 0) assert.equal(fs.statSync(p).ino, before[i].stat.ino); }); noDebris(f);
});
for (const version of ['0.86.2', '0.86.4', '0.86.3-canary.1', '0.86.30', undefined])
  test('unsupported version ' + version, t => rejects(t, f => fs.writeFileSync(f.metadata, JSON.stringify({ version })), /version/i));
test('all-final still validates version', t => rejects(t, f => fs.writeFileSync(f.metadata, '{"version":"0.86.4"}'), /version/i, Array(5).fill('final')));
test('broken metadata', t => rejects(t, f => fs.writeFileSync(f.metadata, '{broken'), /JSON|property|Unexpected/i));
for (let i = 0; i < 5; i++) test('unknown file ' + i + ' preflights before ANY publication', t => rejects(t, f => fs.appendFileSync(f.targets[i], '\n// unknown\n')));
test('missing later file leaves earlier bytes unchanged', t => {
  const f = fixture(t); const before = snapshot(f); fs.unlinkSync(f.targets[4]);
  assert.throws(() => installFinalSources(f.root), /ENOENT/);
  for (let i = 0; i < 4; i++) assert.deepEqual(fs.readFileSync(f.targets[i]), before[i].bytes); noDebris(f);
});
// Tamper copied installer payloads, never the authoritative candidate.
for (const kind of ['path traversal', 'absolute path', 'backslash path', 'duplicate path', 'missing file', 'before hash', 'final hash', 'chunk before hash', 'chunk final hash', 'chunk offset', 'chunk replacement']) {
  test('reject corrupt payload ' + kind + ' without writes', t => {
    const f = fixture(t); const dir = path.join(f.root, 'tool'); fs.mkdirSync(dir);
    for (const file of ['install-final-sources.cjs', 'immutable-rn-source.cjs', 'source-chunks.json']) fs.copyFileSync(path.join(__dirname, file), path.join(dir, file));
    const p = JSON.parse(JSON.stringify(payload)); const c = p[4].chunks[0];
    if (kind === 'path traversal') p[4].relative = '../escape';
    if (kind === 'absolute path') p[4].relative = '/escape';
    if (kind === 'backslash path') p[4].relative = p[4].relative.replaceAll('/', '\\');
    if (kind === 'duplicate path') p[4].relative = p[0].relative;
    if (kind === 'missing file') p.pop();
    if (kind === 'before hash') p[4].beforeSha256 = '0'.repeat(64);
    if (kind === 'final hash') p[4].afterSha256 = '0'.repeat(64);
    if (kind === 'chunk before hash') c.beforeSha256 = '0'.repeat(64);
    if (kind === 'chunk final hash') c.afterSha256 = '0'.repeat(64);
    if (kind === 'chunk offset') c.offset = -1;
    if (kind === 'chunk replacement') c.replacementUtf8 += '// bad';
    fs.writeFileSync(path.join(dir, 'source-chunks.json'), JSON.stringify(p));
    const before = snapshot(f);
    assert.throws(() => require(path.join(dir, 'install-final-sources.cjs')).installFinalSources(f.root), /payload|chunk|path|hash|scope/i);
    untouched(f, before); noDebris(f);
  });
}
for (const which of ['source', 'metadata', 'package', 'modules', 'root', 'ancestor']) test('reject link/junction at ' + which, t => {
  const f = fixture(t); const p = which === 'source' ? f.targets[4] : which === 'metadata' ? f.metadata : which === 'package' ? f.pkg : which === 'modules' ? path.dirname(f.pkg) : which === 'ancestor' ? path.dirname(f.targets[4]) : f.root;
  const real = p + '.real'; fs.renameSync(p, real);
  if (which === 'root') t.after(() => fs.rmSync(real, { recursive: true, force: true }));
  const file = which === 'source' || which === 'metadata';
  try { fs.symlinkSync(real, p, file ? 'file' : process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (!file || error.code !== 'EPERM' || process.platform !== 'win32') throw error;
    fs.renameSync(real, p);
    t.diagnostic('File symlink denied by Windows: modeled lstat; directory junction tests use real OS links.');
    patch(t, 'lstatSync', lstat => (name, ...args) => { const s = lstat(name, ...args); if (path.resolve(name) === p) s.isSymbolicLink = () => true; return s; });
  }
  const before = snapshot(f); assert.throws(() => installFinalSources(f.root), /link|reparse/i); untouched(f, before);
});
for (const which of ['source', 'metadata']) test('real hardlink ' + which + ' rejected before writes', t => rejects(t, f => fs.linkSync(which === 'source' ? f.targets[4] : f.metadata, path.join(f.root, 'alias')), /link/i));
test('foreign lock survives contention', t => {
  const f = fixture(t); const before = snapshot(f); const lock = f.targets[0] + '.repair.lock'; fs.writeFileSync(lock, 'owner');
  assert.throws(() => installFinalSources(f.root), /EEXIST|lock/); untouched(f, before); assert.equal(fs.readFileSync(lock, 'utf8'), 'owner');
});
for (const kind of ['publication failure', 'version change', 'source bytes', 'source identity', 'source hardlink', 'staged bytes', 'staged identity', 'staged hardlink', 'staged link']) test('staging guard and cleanup: ' + kind, t => {
  const f = fixture(t); const before = snapshot(f); let fired = false;
  if (kind === 'publication failure') patch(t, 'renameSync', rename => (from, to) => { if (to === f.targets[0]) throw Error('injected publication failure'); return rename(from, to); });
  else patch(t, 'fsyncSync', sync => fd => {
    sync(fd); if (fired) return; fired = true;
    const target = f.targets[0];
    const staged = fs.readdirSync(path.dirname(target)).find(n => n.startsWith(path.basename(target) + '.') && n.endsWith('.tmp'));
    const temp = path.join(path.dirname(target), staged);
    if (kind === 'version change') fs.writeFileSync(f.metadata, '{"version":"0.86.4"}');
    if (kind === 'source bytes') fs.appendFileSync(target, '// concurrent');
    if (kind === 'source identity') { fs.renameSync(target, target + '.saved'); fs.writeFileSync(target, originals[0]); }
    if (kind === 'source hardlink') fs.linkSync(target, path.join(f.root, 'alias'));
    if (kind === 'staged bytes') fs.writeFileSync(temp, 'corrupt');
    if (kind === 'staged identity') { fs.renameSync(temp, path.join(f.root, 'staged.saved')); fs.writeFileSync(temp, finals[0]); }
    if (kind === 'staged hardlink') fs.linkSync(temp, path.join(f.root, 'alias'));
    if (kind === 'staged link') {
      fs.renameSync(temp, path.join(f.root, 'staged.saved'));
      try { fs.symlinkSync(path.join(f.root, 'staged.saved'), temp, 'file'); }
      catch (error) { if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
        fs.copyFileSync(path.join(f.root, 'staged.saved'), temp);
        t.diagnostic('Staged symlink modeled after Windows EPERM.');
        patch(t, 'lstatSync', lstat => (name, ...args) => { const s = lstat(name, ...args); if (path.resolve(name) === temp) s.isSymbolicLink = () => true; return s; });
      }
    }
  });
  assert.throws(() => installFinalSources(f.root), /failure|changed|hash|link|version|staged/i);
  if (kind === 'source bytes') assert.deepEqual(fs.readFileSync(f.targets[0]), Buffer.concat([originals[0], Buffer.from('// concurrent')]));
  else assert.deepEqual(fs.readFileSync(f.targets[0]), originals[0]);
  for (let i = 1; i < 5; i++) assert.deepEqual(fs.readFileSync(f.targets[i]), before[i].bytes);
  noDebris(f);
});
test('later publication failure is per-file atomic; recognized retry completes', t => {
  const f = fixture(t); const rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (to === f.targets[2]) throw Error('later publication failure'); return rename(from, to); };
  try { assert.throws(() => installFinalSources(f.root), /later publication failure/); } finally { fs.renameSync = rename; }
  f.targets.forEach((p, i) => assert.deepEqual(fs.readFileSync(p), i < 2 ? finals[i] : originals[i])); noDebris(f);
  assert.equal(installFinalSources(f.root), 3); noDebris(f);
});

test('single CLI installs and repeats against a temporary package', t => {
  const { spawnSync } = require('node:child_process');
  const f = fixture(t);
  for (const expected of [5, 0]) {
    const result = spawnSync(process.execPath, ['--max-old-space-size=128', path.join(__dirname, 'install-final-sources.cjs'), f.root], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { changedFiles: expected });
  }
  f.targets.forEach((p, i) => assert.deepEqual(fs.readFileSync(p), finals[i])); noDebris(f);
});
test('CLI requires an explicit project root', () => {
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(process.execPath, ['--max-old-space-size=128', path.join(__dirname, 'install-final-sources.cjs')], { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.match(result.stderr, /Usage/);
});
test('API requires an explicit project root', () => {
  for (const root of [undefined, null, '', 123]) assert.throws(() => installFinalSources(root), /root/i);
});
for (const [name, index, file, hash] of [
  ['arithmetic-only Layout', 0, 'arithmetic-only.kt', '28dc610fbb2db06fc71a57af7a4d85b3c9c741c15153843986d313c034172763'],
  ['ownership-only View', 3, 'ownership-only.java', 'c6621b5224ab4cb980d36dc0c6bca5ae58c84f0bf79e0b3b2a1c2b69439d760a'],
]) test('reject recognized but non-final phase: ' + name, t => rejects(t, f => {
  const bytes = index === 0
    ? Buffer.concat([originals[0].subarray(0, 33432), fs.readFileSync(path.join(__dirname, 'adjustSpannableFontToFit.body.kt')), originals[0].subarray(33432 + 3498)])
    : applyChunks(originals[3], require('./textview-chunks.json').map(c => ({
        offset: c.offset, length: Buffer.byteLength(c.before), replacementUtf8: c.after,
      })));
  assert.equal(sha(bytes), hash);
  fs.writeFileSync(f.targets[index], bytes);
}, /hash|source/i));
for (const which of ['source', 'metadata']) test('directory instead of ' + which + ' prevents any writes', t => {
  const f = fixture(t); const before = snapshot(f); const p = which === 'source' ? f.targets[4] : f.metadata;
  fs.unlinkSync(p); fs.mkdirSync(p);
  assert.throws(() => installFinalSources(f.root), /type/i);
  for (let i = 0; i < (which === 'source' ? 4 : 5); i++) assert.deepEqual(fs.readFileSync(f.targets[i]), before[i].bytes);
  noDebris(f);
});
test('concurrent later-file identity swap after staging is preserved', t => {
  const f = fixture(t); let fired = false;
  patch(t, 'fsyncSync', sync => fd => {
    sync(fd); if (fired) return; fired = true;
    fs.renameSync(f.targets[4], f.targets[4] + '.saved'); fs.writeFileSync(f.targets[4], originals[4]);
  });
  assert.throws(() => installFinalSources(f.root), /changed/i);
  f.targets.forEach((p, i) => assert.deepEqual(fs.readFileSync(p), i < 4 ? finals[i] : originals[i]));
  noDebris(f);
  assert.equal(installFinalSources(f.root), 1); noDebris(f);
});
