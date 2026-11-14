const path = require('node:path');
const { patchWhisperWordBoundaries } = require('./patch-whisper-word-boundaries');
const { patchAndroidDependencies } = require('./patch-android-dependencies');
const { configureAndroidRelease } = require('./configure-android-release');
const { repairReanimatedNativeProps } = require('./repair-reanimated-native-props');
const { repairNativeScrollInput } = require('./repair-native-scroll-input');
const { repairPressableAccessibility } = require('./repair-pressable-accessibility');

function patchReactNativeGradle(projectRoot) {
  patchWhisperWordBoundaries(projectRoot);
  repairPressableAccessibility(projectRoot);
  repairNativeScrollInput(projectRoot);
  repairReanimatedNativeProps(projectRoot);
  patchAndroidDependencies(projectRoot);
  configureAndroidRelease(projectRoot);
}

module.exports = { patchReactNativeGradle };
if (require.main === module) {
  patchReactNativeGradle(path.join(path.dirname(module.filename), '..'));
}
