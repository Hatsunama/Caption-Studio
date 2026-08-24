const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const buildFile = path.join(root, 'node_modules', '@react-native', 'gradle-plugin', 'build.gradle.kts');
const rootBuildFile = path.join(root, 'android', 'build.gradle');
const appBuildFile = path.join(root, 'android', 'app', 'build.gradle');

function replaceInFile(file, from, to) {
  if (!fs.existsSync(file)) return;
  const source = fs.readFileSync(file, 'utf8');
  const next = source.replaceAll(from, to);
  if (next !== source) fs.writeFileSync(file, next);
}

function appendLineIfMissing(file, line) {
  if (!fs.existsSync(file)) return;
  const source = fs.readFileSync(file, 'utf8');
  if (!source.split(/\r?\n/).includes(line)) {
    fs.writeFileSync(file, `${source.trimEnd()}\n\n${line}\n`);
  }
}

function insertAfterIfMissing(file, anchor, line) {
  if (!fs.existsSync(file)) return;
  const source = fs.readFileSync(file, 'utf8');
  if (!source.includes(line)) fs.writeFileSync(file, source.replace(anchor, `${anchor}\n${line}`));
}

const fragileLine =
  'allprojects { tasks.withType<com.ncorti.ktfmt.gradle.tasks.KtfmtCheckTask>() { enabled = false } }';
const compatibleLine =
  'allprojects { tasks.matching { it.name == "ktfmtCheck" }.configureEach { enabled = false } }';
replaceInFile(buildFile, fragileLine, compatibleLine);

// Gradle 9.3 has a confirmed Kotlin DSL failure on some Windows systems.
// Gradle 9.4 fixes that path but embeds Kotlin 2.3, so align only the included
// Gradle build plugins with 2.3. The application compiler remains Expo's 2.1.
replaceInFile(
  path.join(root, 'node_modules', '@react-native', 'gradle-plugin', 'gradle', 'libs.versions.toml'),
  'kotlin = "2.1.20"',
  'kotlin = "2.3.0"',
);
for (const relative of [
  ['@react-native', 'gradle-plugin', 'shared', 'build.gradle.kts'],
  ['@react-native', 'gradle-plugin', 'shared-testutil', 'build.gradle.kts'],
  ['@react-native', 'gradle-plugin', 'settings-plugin', 'build.gradle.kts'],
  ['@react-native', 'gradle-plugin', 'react-native-gradle-plugin', 'build.gradle.kts'],
]) {
  replaceInFile(
    path.join(root, 'node_modules', ...relative),
    'apiVersion.set(KotlinVersion.KOTLIN_1_8)',
    'apiVersion.set(KotlinVersion.KOTLIN_1_9)',
  );
}
replaceInFile(
  path.join(root, 'node_modules', 'expo-modules-autolinking', 'android', 'expo-gradle-plugin', 'build.gradle.kts'),
  'kotlin("jvm") version "2.1.20" apply false',
  'kotlin("jvm") version "2.3.0" apply false',
);
replaceInFile(
  path.join(root, 'node_modules', 'expo-modules-core', 'expo-module-gradle-plugin', 'build.gradle.kts'),
  'kotlin("jvm") version "2.1.20"',
  'kotlin("jvm") version "2.3.0"',
);

replaceInFile(
  path.join(root, 'android', 'gradle', 'wrapper', 'gradle-wrapper.properties'),
  'gradle-9.3.1-bin.zip',
  'gradle-9.4.0-bin.zip',
);
insertAfterIfMissing(
  rootBuildFile,
  "    classpath('com.android.tools.build:gradle')",
  "    classpath('com.android.tools:r8:8.13.19')",
);
replaceInFile(
  path.join(root, 'android', 'gradle.properties'),
  'org.gradle.jvmargs=-Xmx2048m -XX:MaxMetaspaceSize=512m',
  'org.gradle.jvmargs=-Xmx2048m -XX:MaxMetaspaceSize=512m -Dfile.encoding=UTF-8',
);
// A disconnected or unhealthy removable drive can otherwise block Gradle
// while it enumerates every Windows filesystem before the first task starts.
appendLineIfMissing(
  path.join(root, 'android', 'gradle.properties'),
  'org.gradle.vfs.watch=false',
);
appendLineIfMissing(
  path.join(root, 'android', 'gradle.properties'),
  'android.enableMinifyInReleaseBuilds=true',
);
appendLineIfMissing(
  path.join(root, 'android', 'gradle.properties'),
  'android.enableShrinkResourcesInReleaseBuilds=true',
);

const signingProperties = `def captionStudioReleaseStoreFile = findProperty('CAPTION_STUDIO_RELEASE_STORE_FILE')
def captionStudioReleaseStorePassword = findProperty('CAPTION_STUDIO_RELEASE_STORE_PASSWORD')
def captionStudioReleaseKeyAlias = findProperty('CAPTION_STUDIO_RELEASE_KEY_ALIAS')
def captionStudioReleaseKeyPassword = findProperty('CAPTION_STUDIO_RELEASE_KEY_PASSWORD')
def hasCaptionStudioReleaseSigning = [captionStudioReleaseStoreFile, captionStudioReleaseStorePassword, captionStudioReleaseKeyAlias, captionStudioReleaseKeyPassword].every { it }`;

if (fs.existsSync(appBuildFile)) {
  let source = fs.readFileSync(appBuildFile, 'utf8').replaceAll(`${signingProperties}\n\n`, '');
  source = source.replace('android {\n', `${signingProperties}\n\nandroid {\n`);

  const signingConfigs = `    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
        if (hasCaptionStudioReleaseSigning) {
            release {
                storeFile file(captionStudioReleaseStoreFile)
                storePassword captionStudioReleaseStorePassword
                keyAlias captionStudioReleaseKeyAlias
                keyPassword captionStudioReleaseKeyPassword
            }
        }
    }
    buildTypes {`;
  source = source.replace(
    /    signingConfigs \{[\s\S]*?\n    \}\n    buildTypes \{/,
    signingConfigs,
  );

  const buildTypes = `    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            if (hasCaptionStudioReleaseSigning) {
                signingConfig signingConfigs.release
            }
`;
  source = source.replace(
    /    buildTypes \{[\s\S]*?\n        release \{[\s\S]*?(?=            def enableShrinkResources)/,
    buildTypes,
  );
  fs.writeFileSync(appBuildFile, source);
}
appendLineIfMissing(
  appBuildFile,
  `gradle.taskGraph.whenReady { graph -> if (graph.allTasks.any { it.name.toLowerCase().contains('release') } && !hasCaptionStudioReleaseSigning) throw new GradleException('Caption Studio release signing credentials are missing. Configure CAPTION_STUDIO_RELEASE_* in the user Gradle properties file.') }`,
);
