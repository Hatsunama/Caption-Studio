const path = require('node:path');
const { patchAndroidDependencies } = require('./patch-android-dependencies');
const { configureAndroidRelease } = require('./configure-android-release');

const projectRoot = path.join(path.dirname(module.filename), '..');
patchAndroidDependencies(projectRoot);
configureAndroidRelease(projectRoot);
