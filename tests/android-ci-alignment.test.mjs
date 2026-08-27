import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('release CI checks both APK ZIP alignment and every 64-bit ELF LOAD segment', () => {
  const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const checker = readFileSync(new URL('../scripts/check-elf-16k-alignment.sh', import.meta.url), 'utf8');
  assert.match(workflow, /zipalign" -c -P 16 4 "\$apk"/);
  assert.match(workflow, /check-elf-16k-alignment\.sh "\$apk" "\$llvm_objdump"/);
  assert.match(checker, /lib\/arm64-v8a/);
  assert.match(checker, /lib\/x86_64/);
  assert.match(checker, /\$1 == "LOAD"/);
  assert.match(checker, /BASH_REMATCH\[1\] >= 14/);
});
