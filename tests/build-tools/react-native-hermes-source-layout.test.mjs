import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../..', import.meta.url));
const relative = 'ReactAndroid/hermes-engine/build.gradle.kts';
const oldHash = '695979b30215b0ad22e4801c4359a4c2cf27457a7fefce3422397ab56620c6ae';
const newHash = '79fc202074ed52f395429b980d507bff7d896d6edab54b02904af3d17cf92371';
const oldText = 'if (this.path.startsWith("facebook-hermes-")) {';
const newText = 'if (this.path.startsWith("facebook-hermes-") || this.path.startsWith("meta-hermes-")) {';
const hash = data => createHash('sha256').update(data).digest('hex');
const installed = fs.readFileSync(path.join(root, 'node_modules/react-native', relative), 'utf8');
assert.ok([oldHash, newHash].includes(hash(installed)));
const original = hash(installed) === oldHash ? installed : installed.replace(newText, oldText);
assert.equal(hash(original), oldHash);
const repair = project => require('../../scripts/react-native-fontfit/repair-hermes-source-layout.cjs').repairHermesSourceLayout(project);
function fixture(t, version = '0.86.3', source = original) {
 const dir = fs.mkdtempSync(path.join(root, 'tests/.hermes-layout-'));
 t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
 const pkg = path.join(dir, 'node_modules/react-native');
 const file = path.join(pkg, relative);
 fs.mkdirSync(path.dirname(file), { recursive: true });
 fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ version }));
 fs.writeFileSync(file, source);
 return { dir, file };
}
test('exact Hermes source changes only root recognition; repeat is a no-op', t => {
 const f = fixture(t);
 assert.equal(repair(f.dir), true);
 assert.equal(hash(fs.readFileSync(f.file)), newHash);
 assert.equal(fs.readFileSync(f.file, 'utf8').replace(newText, oldText), original);
 const stamp = fs.statSync(f.file).mtimeMs;
 assert.equal(repair(f.dir), false);
 assert.equal(fs.statSync(f.file).mtimeMs, stamp);
});
for (const version of ['0.86.2', '0.86.4', undefined]) test('reject unsupported RN ' + version, t => {
 const f = fixture(t, version);
 if (version === undefined) fs.writeFileSync(path.join(f.dir, 'node_modules/react-native/package.json'), '{}');
 assert.throws(() => repair(f.dir), /version/);
 assert.equal(fs.readFileSync(f.file, 'utf8'), original);
});
test('reject unknown source before writes', t => {
 const f = fixture(t, '0.86.3', original + '// foreign change');
 assert.throws(() => repair(f.dir), /source/);
 assert.equal(fs.readFileSync(f.file, 'utf8'), original + '// foreign change');
});
test('another invocation lock is retained without source changes', t => {
 const f = fixture(t);
 fs.writeFileSync(f.file + '.repair.lock', 'owner');
 assert.throws(() => repair(f.dir), /EEXIST/);
 assert.equal(fs.readFileSync(f.file, 'utf8'), original);
 assert.equal(fs.readFileSync(f.file + '.repair.lock', 'utf8'), 'owner');
});
