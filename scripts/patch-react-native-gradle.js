const path = require('node:path');
const { patchAndroidDependencies } = require('./patch-android-dependencies');
const { configureAndroidRelease } = require('./configure-android-release');
const { repairReanimatedNativeProps } = require('./repair-reanimated-native-props');
const { repairNativeScrollInput } = require('./repair-native-scroll-input');

const projectRoot = path.join(path.dirname(module.filename), '..');
repairNativeScrollInput(projectRoot);
repairReanimatedNativeProps(projectRoot);
patchAndroidDependencies(projectRoot);
configureAndroidRelease(projectRoot);
