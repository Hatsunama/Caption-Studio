import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const { configureAndroidRelease } = require('../scripts/configure-android-release.js');
const { verifyAndroidReleaseConfig } = require('../scripts/verify-android-release-config.js');
const postinstallScripts = [
  'android-patch-utils.js',
  'configure-android-release.js',
  'patch-android-dependencies.js',
  'patch-react-native-gradle.js',
  'repair-reanimated-native-props.js',
  'repair-native-scroll-input.js',
  'repair-pressable-accessibility.js',
  'reanimated-native-props-map.js',
  'verify-android-release-config.js',
];

test('release verifier accepts generated modern Gradle release signing', () => {
  withFixture((root) => assert.doesNotThrow(() => verifyAndroidReleaseConfig(root)));
});

test('clean prebuild aligns every Media3 request, survives reruns and regeneration', () => {
  withFixture((root) => {
    const buildFile = join(root, 'android', 'build.gradle');
    const generated = readFileSync(buildFile, 'utf8');
    configureAndroidRelease(root);
    const aligned = readFileSync(buildFile, 'utf8');
    assert.match(aligned, /allprojects\s*\{[\s\S]*configurations\.configureEach\s*\{/);
    assert.match(aligned, /resolutionStrategy\.eachDependency\s*\{\s*details\s*->/);
    assert.match(aligned, /details\.requested\.group == 'androidx\.media3'/);
    assert.match(aligned, /details\.useVersion\(captionStudioMedia3Version\)/);
    assert.match(aligned, /captionStudioMedia3Version = '1\.11\.0'/);
    // Check selected components too: a later force/strict constraint must fail, not drift.
    assert.match(aligned, /incoming\.afterResolve/);
    assert.match(aligned, /module\.group == 'androidx\.media3'/);
    assert.match(aligned, /module\.version != captionStudioMedia3Version/);
    configureAndroidRelease(root);
    assert.equal(readFileSync(buildFile, 'utf8'), aligned);
    writeFileSync(buildFile, generated);
    configureAndroidRelease(root);
    assert.equal(readFileSync(buildFile, 'utf8'), aligned);
    assert.doesNotThrow(() => verifyAndroidReleaseConfig(root));
  }, false);
});

test('release verifier refuses missing, narrowed, stale or ineffective Media3 alignment', () => {
  for (const mutate of [
    source => source.replace(/\/\/ BEGIN Caption Studio Media3 alignment[\s\S]*?\/\/ END Caption Studio Media3 alignment/g, ''),
    source => source.replace('allprojects {', 'subprojects {'),
    source => source.replace("captionStudioMedia3Version = '1.11.0'", "captionStudioMedia3Version = '1.10.1'"),
    source => source.replace('details.useVersion(captionStudioMedia3Version)', '// no resolution'),
    source => source.replace("details.requested.group == 'androidx.media3'", "details.requested.name == 'media3-transformer'"),
    source => source.replace('incoming.afterResolve', 'incoming.beforeResolve'),
  ]) {
    withFixture((root) => {
      configureAndroidRelease(root);
      const file = join(root, 'android', 'build.gradle');
      writeFileSync(file, mutate(readFileSync(file, 'utf8')));
      assert.throws(() => verifyAndroidReleaseConfig(root), /Media3/i);
    });
  }
});

test('native frame observer has an explicit aligned Media3 UI compile dependency', () => {
  const source = readFileSync(new URL('../modules/caption-media/android/build.gradle', import.meta.url), 'utf8');
  assert.match(source, /^\s*implementation "androidx\.media3:media3-ui:\$\{captionStudioMedia3Version\}"/m);
});

test('release verifier rejects missing or runtime-only native UI dependency', () => {
  for (const mutation of [
    source => source.replace(/^\s*implementation "androidx\.media3:media3-ui:[^\r\n]+/m, ''),
    source => source.replace('implementation "androidx.media3:media3-ui:', 'runtimeOnly "androidx.media3:media3-ui:'),
  ]) {
    withFixture(root => {
      const file = join(root, 'modules', 'caption-media', 'android', 'build.gradle');
      writeFileSync(file, mutation(readFileSync(file, 'utf8')));
      assert.throws(() => verifyAndroidReleaseConfig(root), /Media3/i);
    });
  }
});

test('module Media3 declarations use their own authoritative file without a root fallback', () => {
  withFixture((root) => {
    configureAndroidRelease(root);
    const file = join(root, 'modules', 'caption-media', 'android', 'build.gradle');
    const source = readFileSync(file, 'utf8');
    assert.match(source, /file\('media3-version.properties'\)\.withInputStream/);
    assert.doesNotMatch(source, /rootProject\.ext.*[Mm]edia3|findProperty.*[Mm]edia3/);
    writeFileSync(file, source.replace('${captionStudioMedia3Version}', '1.10.1'));
    assert.throws(() => verifyAndroidReleaseConfig(root), /Media3/i);
  });
});

test('a version change invalidates generated alignment until the configurator regenerates it', () => {
  withFixture((root) => {
    const file = join(root, 'modules', 'caption-media', 'android', 'media3-version.properties');
    writeFileSync(file, 'media3Version=1.11.1\n');
    assert.throws(() => verifyAndroidReleaseConfig(root), /Media3/i);
    configureAndroidRelease(root);
    assert.match(readFileSync(join(root, 'android', 'build.gradle'), 'utf8'), /captionStudioMedia3Version = '1\.11\.1'/);
    assert.doesNotThrow(() => verifyAndroidReleaseConfig(root));
    for (const invalid of ['', 'media3Version=1.+', 'media3Version=1.11.0\nmedia3Version=1.10.1', 'media3Version=1.11.0\nmedia3Version=invalid']) {
      writeFileSync(file, invalid);
      assert.throws(() => configureAndroidRelease(root), /Media3/i);
    }
  });
});

test('existing postinstall hook aligns a newly generated Android project without private inputs', () => {
  withFixture((root) => {
    const buildFile = join(root, 'android', 'build.gradle');
    writeFileSync(buildFile, readFileSync(buildFile, 'utf8').replace(/\/\/ BEGIN Caption Studio Media3 alignment[\s\S]*?\/\/ END Caption Studio Media3 alignment/g, ''));
    // Execute the real entrypoint and configurator; unrelated dependency repairs
    // have their own tests and do not need an installed npm tree in this fixture.
    const unrelatedRepairs = {
      './patch-android-dependencies': { patchAndroidDependencies() {} },
      './repair-reanimated-native-props': { repairReanimatedNativeProps() {} },
      './repair-native-scroll-input': { repairNativeScrollInput() {} },
      './repair-pressable-accessibility': { repairPressableAccessibility() {} },
    };
    runInNewContext(readFileSync(new URL('../scripts/patch-react-native-gradle.js', import.meta.url), 'utf8'), {
      module: { filename: join(root, 'scripts', 'patch-react-native-gradle.js') },
      require: id => id === './configure-android-release'
        ? { configureAndroidRelease }
        : Object.hasOwn(unrelatedRepairs, id) ? unrelatedRepairs[id] : require(id),
    });
    assert.doesNotThrow(() => verifyAndroidReleaseConfig(root));
  });
});

test('release verifier rejects a legacy native application id', () => {
  withFixture((root) => {
    const buildFile = join(root, 'android', 'app', 'build.gradle');
    const source = readFileSync(buildFile, 'utf8').replace(
      "applicationId = 'com.xmilo_at_your_side.caption_studio'",
      "applicationId = 'com.hatsunama.captionstudio'",
    );
    writeFileSync(buildFile, source);
    assert.throws(() => verifyAndroidReleaseConfig(root), /Generated Android application id must be/);
  });
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
    copyPostinstallScripts(root);
    mkdirSync(join(root, 'config'), { recursive: true });
    writeFileSync(
      join(root, 'config', 'product-contract.json'),
      readFileSync(new URL('../config/product-contract.json', import.meta.url), 'utf8'),
      { flag: 'w' },
    );
    const result = spawnSync(process.execPath, ['--max-old-space-size=256', join(root, 'scripts', 'patch-react-native-gradle.js')], {
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

function withFixture(assertion, configure = true) {
  const root = mkdtempSync(join(tmpdir(), 'caption-studio-release-config-'));
  try {
    writeFixture(root);
    if (configure) configureAndroidRelease(root);
    assertion(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function copyPostinstallScripts(root) {
  for (const name of postinstallScripts) {
    write(root, `scripts/${name}`, readFileSync(new URL(`../scripts/${name}`, import.meta.url), 'utf8'));
  }
}

function writeFixture(root) {
  for (const name of ['build.gradle', 'media3-version.properties']) {
    const sourceFile = new URL(`../modules/caption-media/android/${name}`, import.meta.url);
    write(root, `modules/caption-media/android/${name}`, readFileSync(sourceFile, 'utf8'));
  }
  write(
    root,
    'config/product-contract.json',
    readFileSync(new URL('../config/product-contract.json', import.meta.url), 'utf8'),
  );
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
    applicationId = 'com.xmilo_at_your_side.caption_studio'
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
    "buildscript { dependencies {\n    classpath('com.android.tools.build:gradle')\n    classpath('com.android.tools:r8:8.13.19')\n} }\n",
  );
  write(root, 'android/settings.gradle', 'expoAutolinking.useExpoVersionCatalog()\n');
  write(
    root,
    'android/gradle.properties',
    'org.gradle.jvmargs=-Xmx2048m\nandroid.enableMinifyInReleaseBuilds=true\nandroid.enableShrinkResourcesInReleaseBuilds=true\norg.gradle.vfs.watch=false\n',
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
          package: 'com.xmilo_at_your_side.caption_studio',
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
