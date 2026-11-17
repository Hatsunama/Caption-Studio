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
  'patch-whisper-word-boundaries.js',
  'repair-reanimated-native-props.js',
  'repair-native-scroll-input.js',
  'repair-pressable-accessibility.js',
  'reanimated-native-props-map.js',
  'verify-android-release-config.js',
];

const optimizingRules = 'proguardFiles getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro"';
const templateRules = 'proguardFiles getDefaultProguardFile("proguard-android.txt"), "proguard-rules.pro"';

test('R8 repair switches the real Expo default, preserves keeps and is idempotent after regeneration', () => {
  withFixture(root => {
    const app = join(root, 'android/app/build.gradle');
    const rules = join(root, 'android/app/proguard-rules.pro');
    const original = readFileSync(app, 'utf8');
    const keeps = readFileSync(rules, 'utf8');
    assert.ok(original.includes(templateRules));
    configureAndroidRelease(root);
    const configured = readFileSync(app, 'utf8');
    assert.ok(configured.includes(optimizingRules));
    assert.equal(readFileSync(rules, 'utf8'), keeps);
    configureAndroidRelease(root);
    assert.equal(readFileSync(app, 'utf8'), configured);
    writeFileSync(app, original);
    configureAndroidRelease(root);
    assert.equal(readFileSync(app, 'utf8'), configured);
  }, false);
});

test('R8 repair handles single quotes and preserves commented defaults byte for byte', () => {
  withFixture(root => {
    const app = join(root, 'android/app/build.gradle');
    const comment = `// ${templateRules}\n      /* ${optimizingRules} */`;
    writeFileSync(app, readFileSync(app, 'utf8').replace(templateRules, `${comment}\n      ${templateRules.replaceAll('"', "'")}`));
    configureAndroidRelease(root);
    const configured = readFileSync(app, 'utf8');
    assert.ok(configured.includes(comment));
    assert.ok(configured.includes(optimizingRules.replaceAll('"', "'")));
    assert.doesNotThrow(() => verifyAndroidReleaseConfig(root));
    configureAndroidRelease(root);
    assert.equal(readFileSync(app, 'utf8'), configured);
  }, false);
});

for (const [name, mutate] of [
  ['nonoptimizing default', source => source.replace(optimizingRules, templateRules)],
  ['comment-only optimize default', source => source.replace(optimizingRules, `// ${optimizingRules}\n      ${templateRules}`)],
  ['block-comment-only optimize default', source => source.replace(optimizingRules, `/* ${optimizingRules} */`)],
  ['missing rules', source => source.replace(optimizingRules, '')],
  ['both defaults', source => source.replace(optimizingRules, `${optimizingRules}\n      ${templateRules}`)],
]) {
  test(`R8 gate rejects ${name}`, () => {
    withFixture(root => {
      const app = join(root, 'android/app/build.gradle');
      const source = readFileSync(app, 'utf8');
      const changed = mutate(source);
      assert.notEqual(changed, source);
      writeFileSync(app, changed);
      assert.throws(() => verifyAndroidReleaseConfig(root), /proguard|optimiz/i);
    });
  });
}

test('R8 gate checks active local and included rules without rejecting comments or changing JNI keeps', () => {
  withFixture(root => {
    const rules = join(root, 'android/app/proguard-rules.pro');
    const keeps = readFileSync(rules, 'utf8');
    writeFileSync(rules, `${keeps}\n# -dontoptimize\n`);
    assert.doesNotThrow(() => verifyAndroidReleaseConfig(root));
    writeFileSync(rules, `${keeps}\n  -dontoptimize # disables R8 optimization\n`);
    assert.throws(() => verifyAndroidReleaseConfig(root), /dontoptimize/i);
    assert.throws(() => configureAndroidRelease(root), /dontoptimize/i);
    assert.equal(readFileSync(rules, 'utf8'), `${keeps}\n  -dontoptimize # disables R8 optimization\n`);
    writeFileSync(rules, `${keeps}\n-include extra.pro\n`);
    write(root, 'android/app/extra.pro', '-dontoptimize\n');
    assert.throws(() => verifyAndroidReleaseConfig(root), /dontoptimize/i);
    write(root, 'android/app/extra.pro', '# -dontoptimize\n-include proguard-rules.pro\n');
    assert.doesNotThrow(() => verifyAndroidReleaseConfig(root));
  });
});

test('R8 gate checks additional release rule files and available dependency consumer rules', () => {
  withFixture(root => {
    const app = join(root, 'android/app/build.gradle');
    writeFileSync(app, readFileSync(app, 'utf8').replace(optimizingRules, `${optimizingRules}, "extra.pro"`));
    write(root, 'android/app/extra.pro', '-dontoptimize\n');
    assert.throws(() => verifyAndroidReleaseConfig(root), /dontoptimize/i);
    write(root, 'android/app/extra.pro', '# optimization allowed\n');
    for (const file of ['node_modules/react-native/ReactAndroid/proguard-rules.pro', 'node_modules/expo/android/proguard-rules.pro']) {
      write(root, file, '-dontoptimize\n');
      assert.throws(() => verifyAndroidReleaseConfig(root), /dontoptimize/i);
      write(root, file, '# -dontoptimize\n-keepclassmembers class * { native <methods>; }\n');
    }
    assert.doesNotThrow(() => verifyAndroidReleaseConfig(root));
  });
});

test('release verifier accepts generated modern Gradle release signing', () => {
  withFixture((root) => {
    const wrapper = readFileSync(join(root, 'android', 'gradle', 'wrapper', 'gradle-wrapper.properties'), 'utf8');
    assert.match(wrapper, /^distributionUrl=https\\:\/\/services\.gradle\.org\/distributions\/gradle-8\.14\.7-bin\.zip$/m);
    assert.match(wrapper, /^distributionSha256Sum=903bfc4bc7622323124054c10f509246212a1902948bdaf26c379cca8735e856$/m);
    assert.doesNotThrow(() => verifyAndroidReleaseConfig(root));
  });
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
      './patch-whisper-word-boundaries': { patchWhisperWordBoundaries() {} },
      './patch-android-dependencies': { patchAndroidDependencies() {} },
      './repair-reanimated-native-props': { repairReanimatedNativeProps() {} },
      './repair-native-scroll-input': { repairNativeScrollInput() {} },
      './repair-pressable-accessibility': { repairPressableAccessibility() {} },
    };
    const sandbox = {
      module: { filename: join(root, 'scripts', 'patch-react-native-gradle.js'), exports: {} },
      require: id => id === './configure-android-release'
        ? { configureAndroidRelease }
        : Object.hasOwn(unrelatedRepairs, id) ? unrelatedRepairs[id] : require(id),
    };
    sandbox.require.main = sandbox.module;
    runInNewContext(readFileSync(new URL('../scripts/patch-react-native-gradle.js', import.meta.url), 'utf8'), sandbox);
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

// Official HTTPS checksum receipt: gradle-compatibility-followup-20261117/REPORT.md.
const securityGradleUrl = 'https\\://services.gradle.org/distributions/gradle-8.14.7-bin.zip';
const securityGradleSha256 = '903bfc4bc7622323124054c10f509246212a1902948bdaf26c379cca8735e856';

test('Gradle security: known wrapper regeneration pins compatible fixed 8.14.7 and is idempotent', () => {
  withFixture((root) => {
    const wrapperFile = join(root, 'android', 'gradle', 'wrapper', 'gradle-wrapper.properties');
    const generatedWrappers = ['9.3.1', '9.4.0', '9.9.1', '8.14.7'].map(version =>
      `distributionBase=GRADLE_USER_HOME\ndistributionUrl=https\\://services.gradle.org/distributions/gradle-${version}-bin.zip\nnetworkTimeout=10000\nvalidateDistributionUrl=true\n`);
    const files = ['android/gradle/wrapper/gradle-wrapper.properties', 'android/build.gradle', 'android/app/build.gradle', 'android/gradle.properties'];
    const snapshot = () => files.map(file => readFileSync(join(root, file), 'utf8'));
    let configured;
    for (const input of generatedWrappers.flatMap(generated => [generated, `${generated}distributionSha256Sum=${'0'.repeat(64)}\n`])) {
      writeFileSync(wrapperFile, input);
      assert.equal(configureAndroidRelease(root), true);
      const wrapper = readFileSync(wrapperFile, 'utf8');
      assert.deepEqual(wrapper.split(/\r?\n/).filter(line => line.startsWith('distributionUrl=')), [`distributionUrl=${securityGradleUrl}`]);
      assert.deepEqual(wrapper.split(/\r?\n/).filter(line => line.startsWith('distributionSha256Sum=')), [`distributionSha256Sum=${securityGradleSha256}`]);
      assert.ok(wrapper.includes('networkTimeout=10000\n'));
      assert.ok(wrapper.includes('validateDistributionUrl=true\n'));
      assert.doesNotThrow(() => verifyAndroidReleaseConfig(root));
      const current = snapshot();
      if (configured) assert.deepEqual(current, configured);
      configured = current;
      configureAndroidRelease(root);
      assert.deepEqual(snapshot(), configured);
    }
  });
});

test('Gradle security: verifier rejects 9.4.0 even with its valid official checksum', () => {
  withFixture((root) => {
    const wrapperFile = join(root, 'android', 'gradle', 'wrapper', 'gradle-wrapper.properties');
    writeFileSync(wrapperFile, 'distributionUrl=https\\://services.gradle.org/distributions/gradle-9.4.0-bin.zip\ndistributionSha256Sum=60ea723356d81263e8002fec0fcf9e2b0eee0c0850c7a3d7ab0a63f2ccc601f3\n');
    assert.throws(() => verifyAndroidReleaseConfig(root), /Gradle wrapper/i);
  });
});

test('Gradle compatibility: verifier rejects incompatible 9.9.1 even with its valid official checksum', () => {
  withFixture((root) => {
    const wrapperFile = join(root, 'android', 'gradle', 'wrapper', 'gradle-wrapper.properties');
    writeFileSync(wrapperFile, 'distributionUrl=https\\://services.gradle.org/distributions/gradle-9.9.1-bin.zip\ndistributionSha256Sum=d8a18a7a841dd5df825d35a685fad6f2d7f12ac0c280e57b67c27b4a520ba228\n');
    assert.throws(() => verifyAndroidReleaseConfig(root), /Gradle wrapper/i);
  });
});

for (const [name, mutate] of [
  ['tampered checksum', source => source.replace(/^distributionSha256Sum=.*$/m, `distributionSha256Sum=${'0'.repeat(64)}`)],
  ['checksum suffix', source => source.replace(/^(distributionSha256Sum=.*)$/m, '$1tampered')],
  ['commented checksum', source => source.replace(/^distributionSha256Sum=/m, '# distributionSha256Sum=')],
  ['duplicate checksum', source => `${source}distributionSha256Sum=${'0'.repeat(64)}\n`],
  ['untrusted URL host', source => source.replace('services.gradle.org', 'untrusted.invalid')],
  ['insecure URL protocol', source => source.replace('https', 'http')],
  ['URL suffix', source => source.replace('-bin.zip', '-bin.zip.tampered')],
  ['commented URL', source => source.replace(/^distributionUrl=/m, '# distributionUrl=')],
  ['duplicate URL', source => `${source}distributionUrl=https\\://untrusted.invalid/gradle-9.9.1-bin.zip\n`],
]) {
  test(`Gradle security: verifier rejects ${name}`, () => {
    withFixture((root) => {
      const wrapperFile = join(root, 'android', 'gradle', 'wrapper', 'gradle-wrapper.properties');
      const source = readFileSync(wrapperFile, 'utf8');
      const tampered = mutate(source);
      assert.notEqual(tampered, source, 'mutation must exercise the generated configuration');
      writeFileSync(wrapperFile, tampered);
      assert.throws(() => verifyAndroidReleaseConfig(root), /Gradle (?:wrapper|distribution SHA-256)/i);
    });
  });
}

for (const [name, relativePath, mutate, error] of [
  ['credential binding', 'android/app/build.gradle', source => source.replace("findProperty('CAPTION_STUDIO_RELEASE_KEY_PASSWORD')", 'null'), /release key password property/i],
  ['credential gate', 'android/app/build.gradle', source => source.replace('if (hasCaptionStudioReleaseSigning) {\n                signingConfig', 'if (true) {\n                signingConfig'), /credential-gated/i],
  ['minification', 'android/gradle.properties', source => source.replace('android.enableMinifyInReleaseBuilds=true', 'android.enableMinifyInReleaseBuilds=false'), /release R8 minification/i],
  ['resource shrinking', 'android/gradle.properties', source => source.replace('android.enableShrinkResourcesInReleaseBuilds=true', 'android.enableShrinkResourcesInReleaseBuilds=false'), /release resource shrinking/i],
  ['compile SDK', 'node_modules/react-native/gradle/libs.versions.toml', source => source.replace('compileSdk = "36"', 'compileSdk = "35"'), /compileSdk must be 36/i],
  ['minimum SDK', 'node_modules/react-native/gradle/libs.versions.toml', source => source.replace('minSdk = "24"', 'minSdk = "23"'), /minSdk must be 24/i],
]) {
  test(`Gradle security: existing ${name} guard remains enforced`, () => {
    withFixture((root) => {
      const file = join(root, relativePath);
      const source = readFileSync(file, 'utf8');
      const tampered = mutate(source);
      assert.notEqual(tampered, source, 'guard mutation must change the generated configuration');
      writeFileSync(file, tampered);
      assert.throws(() => verifyAndroidReleaseConfig(root), error);
    });
  });
}

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
    `def enableMinifyInReleaseBuilds = (findProperty('android.enableMinifyInReleaseBuilds') ?: false).toBoolean()
def captionStudioReleaseStoreFile = findProperty('CAPTION_STUDIO_RELEASE_STORE_FILE')
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
      def enableShrinkResources = findProperty('android.enableShrinkResourcesInReleaseBuilds') ?: 'false'
      shrinkResources enableShrinkResources.toBoolean()
      minifyEnabled enableMinifyInReleaseBuilds
      proguardFiles getDefaultProguardFile("proguard-android.txt"), "proguard-rules.pro"
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
  write(root, 'android/app/proguard-rules.pro', '# Expo template keeps plus a JNI preservation sentinel\n-keep class com.swmansion.reanimated.** { *; }\n-keep class com.facebook.react.turbomodule.** { *; }\n-keepclassmembers,includedescriptorclasses class * { native <methods>; }\n');
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
    'distributionUrl=https\\://services.gradle.org/distributions/gradle-8.14.7-bin.zip\ndistributionSha256Sum=903bfc4bc7622323124054c10f509246212a1902948bdaf26c379cca8735e856\n',
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

test('R8 release repair preserves a nonoptimizing debug-only default', () => {
  withFixture(root => {
    const app = join(root, 'android/app/build.gradle');
    const source = readFileSync(app, 'utf8');
    const debug = 'debug { signingConfig = signingConfigs.debug }';
    assert.ok(source.includes(debug));
    writeFileSync(app, source.replace(debug, 'debug {\n      signingConfig = signingConfigs.debug\n      ' + templateRules + '\n    }'));
    assert.doesNotThrow(() => verifyAndroidReleaseConfig(root));
    configureAndroidRelease(root);
    const configured = readFileSync(app, 'utf8');
    assert.ok(configured.includes(templateRules), 'debug configuration must remain unchanged');
    assert.ok(configured.includes(optimizingRules), 'release must remain optimized');
  });
});
test('R8 preflight preserves Java annotations in actual-style consumer keep rules', () => {
  withFixture(root => {
    write(root, 'node_modules/react-native/ReactAndroid/proguard-rules.pro',
      '-keep @interface com.facebook.proguard.annotations.DoNotStrip\n' +
      '-keepclassmembers class * {\n  @com.facebook.proguard.annotations.DoNotStrip *;\n}\n');
    assert.doesNotThrow(() => verifyAndroidReleaseConfig(root));
    const rules = join(root, 'android/app/proguard-rules.pro');
    writeFileSync(rules, readFileSync(rules, 'utf8') + '\n-include explicit-disable.pro\n');
    write(root, 'android/app/explicit-disable.pro', '-dontoptimize\n');
    assert.throws(() => verifyAndroidReleaseConfig(root), /dontoptimize/i);
  });
});