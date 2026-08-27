const fs = require('node:fs');
const path = require('node:path');
const {
  assertContains,
  modernizeGroovyAssignments,
  readRequired,
  replaceKnown,
  writeIfChanged,
} = require('./android-patch-utils');

function patchAndroidDependencies(projectRoot = path.join(path.dirname(module.filename), '..')) {
  const nodeModules = path.join(projectRoot, 'node_modules');
  if (!fs.existsSync(nodeModules)) return false;

  const reactNativePlugin = path.join(nodeModules, '@react-native', 'gradle-plugin');
  const pluginBuild = path.join(reactNativePlugin, 'build.gradle.kts');
  const pluginVersions = path.join(reactNativePlugin, 'gradle', 'libs.versions.toml');
  readRequired(pluginBuild);
  readRequired(pluginVersions);

  replaceKnown(
    pluginBuild,
    'allprojects { tasks.withType<com.ncorti.ktfmt.gradle.tasks.KtfmtCheckTask>() { enabled = false } }',
    'allprojects { tasks.matching { it.name == "ktfmtCheck" }.configureEach { enabled = false } }',
  );
  replaceKnown(pluginVersions, 'kotlin = "2.1.20"', 'kotlin = "2.3.0"');

  for (const directory of [
    'shared',
    'shared-testutil',
    'settings-plugin',
    'react-native-gradle-plugin',
  ]) {
    readRequired(path.join(reactNativePlugin, directory, 'build.gradle.kts'));
    replaceKnown(
      path.join(reactNativePlugin, directory, 'build.gradle.kts'),
      'apiVersion.set(KotlinVersion.KOTLIN_1_8)',
      'apiVersion.set(KotlinVersion.KOTLIN_1_9)',
    );
  }

  const expoAutolinkingBuild = path.join(
    nodeModules,
    'expo-modules-autolinking',
    'android',
    'expo-gradle-plugin',
    'build.gradle.kts',
  );
  const expoModulePluginBuild = path.join(
    nodeModules,
    'expo-modules-core',
    'expo-module-gradle-plugin',
    'build.gradle.kts',
  );
  replaceKnown(
    expoAutolinkingBuild,
    'kotlin("jvm") version "2.1.20" apply false',
    'kotlin("jvm") version "2.3.0" apply false',
  );
  replaceKnown(
    expoModulePluginBuild,
    'kotlin("jvm") version "2.1.20"',
    'kotlin("jvm") version "2.3.0"',
  );

  removeManifestPackage(
    path.join(nodeModules, 'whisper.rn', 'android', 'src', 'main', 'AndroidManifest.xml'),
    'com.rnwhisper',
  );
  removeManifestPackage(
    path.join(
      nodeModules,
      'react-native-safe-area-context',
      'android',
      'src',
      'main',
      'AndroidManifest.xml',
    ),
    'com.th3rdwave.safeareacontext',
  );

  for (const file of [
    path.join(nodeModules, '@expo', 'log-box', 'android', 'build.gradle'),
    path.join(nodeModules, '@react-native-masked-view', 'masked-view', 'android', 'build.gradle'),
    path.join(nodeModules, 'expo', 'android', 'build.gradle'),
    path.join(nodeModules, 'expo-constants', 'android', 'build.gradle'),
    path.join(nodeModules, 'expo-modules-core', 'android', 'build.gradle'),
    path.join(nodeModules, 'expo-sharing', 'android', 'build.gradle'),
    path.join(nodeModules, 'react-native-gesture-handler', 'android', 'build.gradle'),
    path.join(nodeModules, 'react-native-safe-area-context', 'android', 'build.gradle'),
    path.join(nodeModules, 'react-native-screens', 'android', 'build.gradle'),
    path.join(nodeModules, 'whisper.rn', 'android', 'build.gradle'),
  ]) {
    modernizeGroovyAssignments(file);
  }

  assertContains(pluginBuild, 'tasks.matching { it.name == "ktfmtCheck" }', 'Gradle-compatible ktfmt configuration');
  assertContains(pluginVersions, 'kotlin = "2.3.0"', 'Gradle plugin Kotlin alignment');
  assertContains(expoAutolinkingBuild, 'kotlin("jvm") version "2.3.0" apply false', 'Expo autolinking Kotlin alignment');
  assertContains(expoModulePluginBuild, 'kotlin("jvm") version "2.3.0"', 'Expo module Kotlin alignment');
  return true;
}

function removeManifestPackage(file, packageName) {
  const source = readRequired(file);
  const next = source.replace(
    new RegExp(`\\s+package=["']${escapeRegExp(packageName)}["']`),
    '',
  );
  writeIfChanged(file, source, next);
  if (/\s+package=["'][^"']+["']/.test(next)) {
    throw new Error(`Deprecated Android manifest package remains in ${file}.`);
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

if (require.main === module) patchAndroidDependencies();

module.exports = { patchAndroidDependencies };
