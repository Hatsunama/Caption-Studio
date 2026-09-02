const fs = require('node:fs');
const path = require('node:path');

const REQUIRED_ANDROID_SDK = '36';
const REQUIRED_MIN_ANDROID_SDK = '24';
const REQUIRED_GRADLE_DISTRIBUTION_SHA256 = '60ea723356d81263e8002fec0fcf9e2b0eee0c0850c7a3d7ab0a63f2ccc601f3';
const PRODUCTION_ANDROID_PACKAGE = 'com.hatsunama.captionstudio';
const FIXED_ANDROID_PACKAGE = 'com.hatsunama.captionstudio.fixed';
const APPROVED_ANDROID_PACKAGES = new Set([
  PRODUCTION_ANDROID_PACKAGE,
  FIXED_ANDROID_PACKAGE,
]);

function resolveExpectedAndroidPackage(environment = process.env) {
  const expectedPackage =
    environment.CAPTION_STUDIO_EXPECTED_ANDROID_PACKAGE || PRODUCTION_ANDROID_PACKAGE;
  if (!APPROVED_ANDROID_PACKAGES.has(expectedPackage)) {
    throw new Error(`Unsupported Android application id requested for release verification: ${expectedPackage}`);
  }
  return expectedPackage;
}

function verifyAndroidReleaseConfig(projectRoot = path.join(path.dirname(module.filename), '..')) {
  const appBuild = readRequired(path.join(projectRoot, 'android', 'app', 'build.gradle'));
  const rootBuild = readRequired(path.join(projectRoot, 'android', 'build.gradle'));
  const settings = readRequired(path.join(projectRoot, 'android', 'settings.gradle'));
  const properties = readRequired(path.join(projectRoot, 'android', 'gradle.properties'));
  const wrapper = readRequired(
    path.join(projectRoot, 'android', 'gradle', 'wrapper', 'gradle-wrapper.properties'),
  );
  const reactNativeVersions = readRequired(
    path.join(projectRoot, 'node_modules', 'react-native', 'gradle', 'libs.versions.toml'),
  );
  const appConfig = JSON.parse(readRequired(path.join(projectRoot, 'app.json')));
  const expectedAndroidPackage = resolveExpectedAndroidPackage();

  requireText(appBuild, "findProperty('CAPTION_STUDIO_RELEASE_STORE_FILE')", 'release keystore property');
  requireText(appBuild, "findProperty('CAPTION_STUDIO_RELEASE_STORE_PASSWORD')", 'release keystore password property');
  requireText(appBuild, "findProperty('CAPTION_STUDIO_RELEASE_KEY_ALIAS')", 'release key alias property');
  requireText(appBuild, "findProperty('CAPTION_STUDIO_RELEASE_KEY_PASSWORD')", 'release key password property');

  const signingConfigs = findNamedBlock(appBuild, 'signingConfigs', 'signing configurations');
  const releaseSigning = findNamedBlock(signingConfigs, 'release', 'release signing configuration');
  requirePattern(releaseSigning, /storeFile\s*(?:=\s*)?file\(captionStudioReleaseStoreFile\)/, 'release keystore binding');
  requirePattern(releaseSigning, /storePassword\s*(?:=\s*)?captionStudioReleaseStorePassword/, 'release keystore password binding');
  requirePattern(releaseSigning, /keyAlias\s*(?:=\s*)?captionStudioReleaseKeyAlias/, 'release key alias binding');
  requirePattern(releaseSigning, /keyPassword\s*(?:=\s*)?captionStudioReleaseKeyPassword/, 'release key password binding');

  const buildTypes = findNamedBlock(appBuild, 'buildTypes', 'build types');
  const releaseBuild = findNamedBlock(buildTypes, 'release', 'release build type');
  if (/signingConfigs\.debug|debug\.keystore|androiddebugkey/i.test(releaseBuild)) {
    throw new Error('Generated Android release configuration still uses the debug keystore.');
  }
  requirePattern(
    releaseBuild,
    /if\s*\(\s*hasCaptionStudioReleaseSigning\s*\)\s*\{[\s\S]*?signingConfig\s*=\s*signingConfigs\.release/,
    'credential-gated production release signing configuration',
  );
  requirePattern(appBuild, /tasks\.configureEach\s*\{\s*task\s*->/, 'lazy release-task signing guard');
  requireText(appBuild, 'Caption Studio release signing credentials are missing', 'release-task signing guard');
  if (appBuild.includes('gradle.taskGraph.whenReady')) {
    throw new Error('Generated Android release configuration uses the legacy Gradle task graph API.');
  }

  requirePattern(appBuild, /compileSdk\s*(?:=\s*)?rootProject\.ext\.compileSdkVersion/, 'compile SDK binding');
  requirePattern(appBuild, /minSdkVersion\s*(?:=\s*)?rootProject\.ext\.minSdkVersion/, 'minimum SDK binding');
  requirePattern(appBuild, /targetSdkVersion\s*(?:=\s*)?rootProject\.ext\.targetSdkVersion/, 'target SDK binding');
  requireText(settings, 'expoAutolinking.useExpoVersionCatalog()', 'Expo version catalog');
  requireTomlVersion(reactNativeVersions, 'compileSdk', REQUIRED_ANDROID_SDK);
  requireTomlVersion(reactNativeVersions, 'targetSdk', REQUIRED_ANDROID_SDK);
  requireTomlVersion(reactNativeVersions, 'minSdk', REQUIRED_MIN_ANDROID_SDK);

  requireText(properties, 'android.enableMinifyInReleaseBuilds=true', 'release R8 minification');
  requireText(properties, 'android.enableShrinkResourcesInReleaseBuilds=true', 'release resource shrinking');
  requireText(properties, 'org.gradle.vfs.watch=false', 'stable Windows Gradle filesystem behavior');
  requireText(rootBuild, "classpath('com.android.tools:r8:8.13.19')", 'pinned R8 implementation');
  requireText(wrapper, 'gradle-9.4.0-bin.zip', 'verified Gradle wrapper version');
  requireText(
    wrapper,
    `distributionSha256Sum=${REQUIRED_GRADLE_DISTRIBUTION_SHA256}`,
    'verified Gradle distribution SHA-256',
  );

  const androidConfig = appConfig.expo?.android;
  if (androidConfig?.package !== expectedAndroidPackage) {
    throw new Error(
      `app.json Android application id must be ${expectedAndroidPackage}; found ${androidConfig?.package ?? 'nothing'}.`,
    );
  }
  if (!Number.isInteger(androidConfig.versionCode) || androidConfig.versionCode < 1) {
    throw new Error('app.json does not declare a valid positive Android versionCode.');
  }
  if (androidConfig.allowBackup !== false) {
    throw new Error('Android backups must remain disabled for release builds.');
  }
}

function readRequired(file) {
  if (!fs.existsSync(file)) throw new Error(`Required generated Android file is missing: ${file}`);
  return fs.readFileSync(file, 'utf8');
}

function requireText(source, expected, purpose) {
  if (!source.includes(expected)) throw new Error(`Generated Android configuration is missing ${purpose}.`);
}

function requirePattern(source, expected, purpose) {
  if (!expected.test(source)) throw new Error(`Generated Android configuration is missing ${purpose}.`);
}

function requireTomlVersion(source, name, expected) {
  const match = source.match(new RegExp(`^${name}\\s*=\\s*["']([^"']+)["']\\s*$`, 'm'));
  if (match?.[1] !== expected) {
    throw new Error(`React Native Android ${name} must be ${expected}; found ${match?.[1] ?? 'nothing'}.`);
  }
}

function findNamedBlock(source, name, purpose) {
  const match = new RegExp(`\\b${escapeRegExp(name)}\\s*\\{`).exec(source);
  if (!match) throw new Error(`Generated Android configuration is missing ${purpose}.`);
  const openingBrace = source.indexOf('{', match.index);
  let depth = 0;
  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(match.index, index + 1);
  }
  throw new Error(`Generated Android configuration has an unterminated ${purpose} block.`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

if (require.main === module) verifyAndroidReleaseConfig();

module.exports = {
  FIXED_ANDROID_PACKAGE,
  PRODUCTION_ANDROID_PACKAGE,
  resolveExpectedAndroidPackage,
  verifyAndroidReleaseConfig,
};
