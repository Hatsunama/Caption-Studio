import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../vendor/reviewed-backports/', import.meta.url));
const probe = "const pm=require(process.argv[1]);const a=JSON.parse(process.argv[2]);pm.makeRe(a[0]).test(a[1]);process.stdout.write('completed');";
for (const major of [2, 4]) {
  const entry = path.join(root, 'picomatch-v' + major, 'index.js');
  for (const [pattern, input] of [
    ['+(*)b', 'a'.repeat(48) + '!'],
    ['+(*a)', 'a'.repeat(48) + '!'],
    ['*(a*)b', 'a'.repeat(48) + '!'],
    ['p+(@(*a))q', 'p' + 'a'.repeat(48) + '!'],
  ]) {
    test('picomatch v' + major + ' bounds repeated wildcard matching: ' + pattern, () => {
      const result = spawnSync(process.execPath, ['--max-old-space-size=32', '-e', probe, entry,
        JSON.stringify([pattern, input])], { timeout: 1500, encoding: 'utf8', windowsHide: true });
      assert.equal(result.status, 0, 'default matching must finish instead of exhausting the subprocess deadline');
      assert.equal(result.stdout, 'completed');
    });
  }
  test('picomatch v' + major + ' preserves ordinary build globs and nonhazardous extglobs', () => {
    const pm = require(entry);
    const cases = [
      ['src/*.{ts,tsx}', ['src/a.ts', 'src/b.tsx', 'src/c.js', 'src/deep/a.ts'], ['src/a.ts', 'src/b.tsx']],
      ['assets/**/*.png', ['assets/a.png', 'assets/deep/b.png', 'assets/a.jpg'], ['assets/a.png', 'assets/deep/b.png']],
      ['*.js', ['a.js', '.a.js', 'a.ts'], ['a.js']],
      ['+(a|b)', ['a', 'ab', 'baba', 'abc'], ['a', 'ab', 'baba']],
      ['+(ab)', ['ab', 'abab', 'aba'], ['ab', 'abab']],
      ['file-@(a|b).js', ['file-a.js', 'file-b.js', 'file-c.js'], ['file-a.js', 'file-b.js']],
      ['+([*]a)', ['*a', '*a*a', 'aa'], ['*a', '*a*a']],
      ['file-?.js', ['file-a.js', 'file-ab.js', 'file-.js'], ['file-a.js']],
      ['+(*(a))', ['a', 'aa', 'aaa', 'b'], ['a', 'aa', 'aaa']],
    ];
    for (const [pattern, inputs, expected] of cases)
      assert.deepEqual(inputs.filter(input => pm(pattern)(input)), expected, pattern);
    assert.equal(pm.isMatch('.a.js', '*.js', { dot: true }), true);
    assert.equal(pm.scan('src/**/*.js').isGlob, true);
    assert.equal(pm.makeRe('+(ab)', { capture: true }).test('abab'), true);
    assert.equal(pm.isMatch('a', '+(*a)', { noextglob: true }), false);
  });
}