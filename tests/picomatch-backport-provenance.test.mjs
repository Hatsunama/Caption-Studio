import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const config = JSON.parse(readFileSync(path.join(root, 'config/picomatch-backports.json')));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inspect = [
  'import sys,tarfile,json,hashlib',
  "with tarfile.open(sys.argv[1],'r:gz') as t:",
  ' result={}',
  ' for m in t.getmembers():',
  "  assert m.isfile() and m.name.startswith('package/') and '..' not in m.name.split('/')",
  "  n=m.name[len('package/'):]",
  '  assert n not in result',
  '  result[n]=hashlib.sha256(t.extractfile(m).read()).hexdigest()',
  ' print(json.dumps(result))',
].join('\n');
for (const [major, record] of Object.entries(config.packages)) {
  test('picomatch v' + major + ' distribution matches reviewed source and original-file delta', () => {
    const directory = path.join(root, 'vendor/reviewed-backports/picomatch-v' + major);
    const actual = {};
    for (const [file, expected] of Object.entries(record.originalFiles)) {
      const bytes = readFileSync(path.join(directory, file));
      actual[file] = hash(bytes);
      let restored = bytes;
      if (file === 'lib/parse.js') {
        let code = bytes.toString();
        const start = code.indexOf('// A wildcard star inside an outer repetition');
        const end = code.indexOf('const analyzeRepeatedExtglob = (body, options) => {', start);
        assert.ok(start >= 0 && end > start);
        code = code.slice(0, start) + code.slice(end);
        const guard = '  if (branches.some(hasRepeatedWildcardStar)) {\n    return { risky: true };\n  }\n\n';
        assert.equal(code.split(guard).length, 2);
        restored = Buffer.from(code.replace(guard, ''));
      } else if (file === 'package.json') {
        restored = Buffer.from(bytes.toString().replace(JSON.stringify(record.name), '"picomatch"')
          .replace(JSON.stringify(record.version), JSON.stringify(record.originalVersion)));
      }
      assert.equal(hash(restored), expected, file + ': unrelated upstream bytes must remain unchanged');
    }
    const archive = path.join(root, 'vendor/reviewed-backports', record.archive);
    assert.equal('sha512-' + createHash('sha512').update(readFileSync(archive)).digest('base64'), record.integrity);
    const packed = JSON.parse(execFileSync(process.platform === 'win32' ? 'python' : 'python3',
      ['-c', inspect, archive], { encoding: 'utf8', windowsHide: true }));
    assert.deepEqual(packed, actual, 'pinned tarball must contain exactly the reviewed source bytes');
    const manifest = JSON.parse(readFileSync(path.join(root, 'package.json')));
    assert.equal(manifest.overrides[major === '2' ? 'picomatch@^2' : 'picomatch@>=3'], record.resolved);
    assert.ok(record.resolved.includes('/02dbbc68517b96ad14bcca443205c4515d79ca11/'));
  });
}