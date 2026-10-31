const path = require('node:path');
const { patchAndroidDependencies } = require('./patch-android-dependencies');
const { configureAndroidRelease } = require('./configure-android-release');
const { repairReanimatedNativeProps } = require('./repair-reanimated-native-props');

const projectRoot = path.join(path.dirname(module.filename), '..');
repairReanimatedNativeProps(projectRoot);
patchAndroidDependencies(projectRoot);
configureAndroidRelease(projectRoot);
