'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Explicit Android-only boundary: invoke after prebuild and clean-lock host tests,
// before any Gradle invocation, with no overlapping dependency/native writers.
function prepareAndroidRuntime(projectRoot) {
  if (typeof projectRoot !== 'string' || !projectRoot.trim()) throw Error('Explicit project root required');
  const root = path.resolve(projectRoot);
  if (!fs.lstatSync(path.join(root, 'android/settings.gradle')).isFile()) {
    throw Error('Run Android prebuild before runtime preparation');
  }
  require('./patch-react-native-gradle.js').patchReactNativeGradle(root);
  require('./react-native-fontfit/install-final-sources.cjs').installFinalSources(root);
  require('./configure-react-native-source.js').configureReactNativeSource(root);
  require('./align-react-native-source-kotlin.cjs').alignReactNativeSourceKotlin(root, { sourceBuild: true });
  require('./react-native-fontfit/repair-hermes-source-layout.cjs').repairHermesSourceLayout(root);
}

module.exports = { prepareAndroidRuntime };
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== '--after-prebuild' || !args[1].trim()) {
      throw Error('Usage: node scripts/prepare-android-runtime.cjs --after-prebuild <project-root>');
    }
    prepareAndroidRuntime(args[1]);
    console.log('Android runtime preparation completed.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
