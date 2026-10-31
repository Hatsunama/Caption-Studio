import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

test('the actual postinstall connects native-prop delivery repair before configuring Android', () => {
  const filename = fileURLToPath(new URL('../scripts/patch-react-native-gradle.js', import.meta.url));
  const calls = [];
  runInNewContext(readFileSync(filename, 'utf8'), {
    module: { filename },
    require(id) {
      if (id === 'node:path') return path;
      if (id === './patch-android-dependencies') return { patchAndroidDependencies: root => calls.push(['android', root]) };
      if (id === './configure-android-release') return { configureAndroidRelease: root => calls.push(['release', root]) };
      if (id === './repair-reanimated-native-props') return { repairReanimatedNativeProps: root => calls.push(['delivery', root]) };
      throw Error(`Unexpected postinstall dependency ${id}`);
    },
  });
  const root = path.join(path.dirname(filename), '..');
  assert.deepEqual(calls, [['delivery', root], ['android', root], ['release', root]]);
});
