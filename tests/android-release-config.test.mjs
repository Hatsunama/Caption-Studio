import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { verifyAndroidReleaseConfig } = require('../scripts/verify-android-release-config.js');
const postinstallScripts = [
  'android-patch-utils.js',
  'configure-android-release.js',
  'patch-android-dependencies.js',
  'patch-react-native-gradle.js',
  'verify-android-release-config.js',
];

test('release verifier accepts generated modern Gradle release signing', () => {
  withFixture((root) => assert.doesNotThrow(() => verifyAndroidReleaseConfig(root)));
});

test('release verifier rejects a debug-signed release build', () => {
  withFixture((root) => {
    const buildFile = join(root, 'android', 'app', 'build.gradle');
    const source = readFileSync(buildFile, 'utf8').replace(
      'signingConfig = signingConfigs.release',
      'signingConfig = signingConfigs.debug',
    );
    writeFileSync(buildFile, source);
    assert.throws(() => verifyAndroidReleaseConfig(root), /debug keystore/i);
  });
});

test('release verifier rejects an Android target below API 36', () => {
  withFixture((root) => {
    const versionsFile = join(root, 'node_modules', 'react-native', 'gradle', 'libs.versions.toml');
    const source = readFileSync(versionsFile, 'utf8').replace('targetSdk = "36"', 'targetSdk = "35"');
    writeFileSync(versionsFile, source);
    assert.throws(() => verifyAndroidReleaseConfig(root), /targetSdk must be 36/i);
  });
});

test('release verifier rejects an unpinned Gradle distribution', () => {
  withFixture((root) => {
    const wrapperFile = join(root, 'android', 'gradle', 'wrapper', 'gradle-wrapper.properties');
    const source = readFileSync(wrapperFile, 'utf8').replace(/^distributionSha256Sum=.*$/m, '');
    writeFileSync(wrapperFile, source);
    assert.throws(() => verifyAndroidReleaseConfig(root), /Gradle distribution SHA-256/i);
  });
});

test('postinstall patch succeeds before a generated Android directory exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'caption-studio-postinstall-'));
  try {
    const scriptDirectory = join(root, 'scripts');
    mkdirSync(scriptDirectory, { recursive: true });
    for (const name of postinstallScripts) {
      writeFileSync(
        join(scriptDirectory, name),
        readFileSync(new URL(`../scripts/${name}`, import.meta.url), 'utf8'),
      );
    }
    const result = spawnSync(process.execPath, [join(scriptDirectory, 'patch-react-native-gradle.js')], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.signal, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the public signing lineage survives a clone and local cleanup', () => {
  const ignoreRules = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');
  const attributes = readFileSync(new URL('../.gitattributes', import.meta.url), 'utf8');
  const lineage = readFileSync(new URL('../signing/caption-studio-lineage.bin', import.meta.url));
  assert.match(ignoreRules, /!\/signing\/caption-studio-lineage\.bin/);
  assert.match(attributes, /^\*\.bin binary$/m);
  assert.ok(lineage.length > 0);
});

function withFixture(assertion) {
  const root = mkdtempSync(join(tmpdir(), 'caption-studio-release-config-'));
  try {
    writeFixture(root);
    assertion(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeFixture(root) {
  write(
    root,
    'android/app/build.gradle',
    `def captionStudioReleaseStoreFile = findProperty('CAPTION_STUDIO_RELEASE_STORE_FILE')
def captionStudioReleaseStorePassword = findProperty('CAPTION_STUDIO_RELEASE_STORE_PASSWORD')
def captionStudioReleaseKeyAlias = findProperty('CAPTION_STUDIO_RELEASE_KEY_ALIAS')
def captionStudioReleaseKeyPassword = findProperty('CAPTION_STUDIO_RELEASE_KEY_PASSWORD')
def hasCaptionStudioReleaseSigning = [captionStudioReleaseStoreFile, captionStudioReleaseStorePassword, captionStudioReleaseKeyAlias, captionStudioReleaseKeyPassword].every { it }
android {
  compileSdk = rootProject.ext.compileSdkVersion
  defaultConfig {
    minSdkVersion = rootProject.ext.minSdkVersion
    targetSdkVersion = rootProject.ext.targetSdkVersion
  }
  signingConfigs {
    debug {
      storeFile = file('debug.keystore')
      keyAlias = 'androiddebugkey'
    }
    if (hasCaptionStudioReleaseSigning) {
      release {
        storeFile = file(captionStudioReleaseStoreFile)
        storePassword = captionStudioReleaseStorePassword
        keyAlias = captionStudioReleaseKeyAlias
        keyPassword = captionStudioReleaseKeyPassword
      }
    }
  }
  buildTypes {
    debug { signingConfig = signingConfigs.debug }
    release {
      if (hasCaptionStudioReleaseSigning) {
        signingConfig = signingConfigs.release
      }
    }
  }
}
tasks.configureEach { task ->
  task.doFirst { throw new GradleException('Caption Studio release signing credentials are missing') }
}
`,
  );
  write(
    root,
    'android/build.gradle',
    "dependencies { classpath('com.android.tools:r8:8.13.19') }\n",
  );
  write(root, 'android/settings.gradle', 'expoAutolinking.useExpoVersionCatalog()\n');
  write(
    root,
    'android/gradle.properties',
    'android.enableMinifyInReleaseBuilds=true\nandroid.enableShrinkResourcesInReleaseBuilds=true\norg.gradle.vfs.watch=false\n',
  );
  write(
    root,
    'android/gradle/wrapper/gradle-wrapper.properties',
    'distributionUrl=https\\://services.gradle.org/distributions/gradle-9.4.0-bin.zip\ndistributionSha256Sum=60ea723356d81263e8002fec0fcf9e2b0eee0c0850c7a3d7ab0a63f2ccc601f3\n',
  );
  write(
    root,
    'node_modules/react-native/gradle/libs.versions.toml',
    'minSdk = "24"\ntargetSdk = "36"\ncompileSdk = "36"\n',
  );
  write(
    root,
    'app.json',
    JSON.stringify({
      expo: {
        android: {
          package: 'com.hatsunama.captionstudio',
          versionCode: 12,
          allowBackup: false,
        },
      },
    }),
  );
}

function write(root, relativePath, contents) {
  const file = join(root, relativePath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents);
}
