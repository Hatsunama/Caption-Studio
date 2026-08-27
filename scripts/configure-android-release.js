const fs = require('node:fs');
const path = require('node:path');
const {
  appendLineIfMissing,
  findNamedBlockRange,
  insertAfterRequired,
  modernizeGroovyAssignments,
  readRequired,
  replaceKnown,
  replaceLineRequired,
  replaceRange,
} = require('./android-patch-utils');
const { verifyAndroidReleaseConfig } = require('./verify-android-release-config');

const gradleDistributionSha256 = 'distributionSha256Sum=60ea723356d81263e8002fec0fcf9e2b0eee0c0850c7a3d7ab0a63f2ccc601f3';

const signingProperties = `def captionStudioReleaseStoreFile = findProperty('CAPTION_STUDIO_RELEASE_STORE_FILE')
def captionStudioReleaseStorePassword = findProperty('CAPTION_STUDIO_RELEASE_STORE_PASSWORD')
def captionStudioReleaseKeyAlias = findProperty('CAPTION_STUDIO_RELEASE_KEY_ALIAS')
def captionStudioReleaseKeyPassword = findProperty('CAPTION_STUDIO_RELEASE_KEY_PASSWORD')
def hasCaptionStudioReleaseSigning = [captionStudioReleaseStoreFile, captionStudioReleaseStorePassword, captionStudioReleaseKeyAlias, captionStudioReleaseKeyPassword].every { it }`;

const releaseSigningBlock = `signingConfigs {
        debug {
            storeFile = file('debug.keystore')
            storePassword = 'android'
            keyAlias = 'androiddebugkey'
            keyPassword = 'android'
        }
        if (hasCaptionStudioReleaseSigning) {
            release {
                storeFile = file(captionStudioReleaseStoreFile)
                storePassword = captionStudioReleaseStorePassword
                keyAlias = captionStudioReleaseKeyAlias
                keyPassword = captionStudioReleaseKeyPassword
            }
        }
    }`;

const releaseSigningGuard = `tasks.configureEach { task ->
    if (task.name.toLowerCase().contains('release')) {
        task.doFirst {
            if (!hasCaptionStudioReleaseSigning) {
                throw new GradleException('Caption Studio release signing credentials are missing. Configure CAPTION_STUDIO_RELEASE_* in the user Gradle properties file.')
            }
        }
    }
}`;

function configureAndroidRelease(projectRoot = path.join(path.dirname(module.filename), '..')) {
  const androidRoot = path.join(projectRoot, 'android');
  if (!fs.existsSync(androidRoot)) return false;

  const rootBuild = path.join(androidRoot, 'build.gradle');
  const appBuild = path.join(androidRoot, 'app', 'build.gradle');
  const properties = path.join(androidRoot, 'gradle.properties');
  const wrapper = path.join(androidRoot, 'gradle', 'wrapper', 'gradle-wrapper.properties');
  for (const file of [rootBuild, appBuild, properties, wrapper]) readRequired(file);

  replaceKnown(wrapper, 'gradle-9.3.1-bin.zip', 'gradle-9.4.0-bin.zip');
  const wrapperSource = readRequired(wrapper);
  fs.writeFileSync(
    wrapper,
    /^distributionSha256Sum=.*$/m.test(wrapperSource)
      ? wrapperSource.replace(/^distributionSha256Sum=.*$/m, gradleDistributionSha256)
      : `${wrapperSource.trimEnd()}\n${gradleDistributionSha256}\n`,
  );
  insertAfterRequired(
    rootBuild,
    "    classpath('com.android.tools.build:gradle')",
    "    classpath('com.android.tools:r8:8.13.19')",
  );
  replaceLineRequired(
    properties,
    /^org\.gradle\.jvmargs=.*$/m,
    'org.gradle.jvmargs=-Xmx2048m -XX:MaxMetaspaceSize=1024m -Dfile.encoding=UTF-8',
  );
  appendLineIfMissing(properties, 'org.gradle.vfs.watch=false');
  appendLineIfMissing(properties, 'android.enableMinifyInReleaseBuilds=true');
  appendLineIfMissing(properties, 'android.enableShrinkResourcesInReleaseBuilds=true');

  modernizeGroovyAssignments(rootBuild);
  configureSigning(appBuild);
  modernizeGroovyAssignments(appBuild);
  verifyAndroidReleaseConfig(projectRoot);
  return true;
}

function configureSigning(appBuild) {
  let source = readRequired(appBuild);
  source = source.replaceAll(`${signingProperties}\n\n`, '').replaceAll(signingProperties, '');
  if (!source.includes('android {')) {
    throw new Error(`Generated Android application build file has no android block: ${appBuild}`);
  }
  source = source.replace('android {', `${signingProperties}\n\nandroid {`);

  const signingRange = findNamedBlockRange(source, 'signingConfigs', 'signing configurations');
  source = replaceRange(source, signingRange, releaseSigningBlock);

  const buildTypesRange = findNamedBlockRange(source, 'buildTypes', 'build types');
  const buildTypes = source.slice(buildTypesRange.start, buildTypesRange.end);
  const releaseRange = findNamedBlockRange(buildTypes, 'release', 'release build type');
  let releaseBuild = buildTypes.slice(releaseRange.start, releaseRange.end);
  releaseBuild = releaseBuild
    .replace(
      /\n\s*if\s*\(\s*hasCaptionStudioReleaseSigning\s*\)\s*\{\s*signingConfig\s*(?:=\s*)?signingConfigs\.release\s*\}/g,
      '',
    )
    .replace(/^\s*signingConfig\s*(?:=\s*)?[^\r\n]+\r?\n?/gm, '');
  releaseBuild = releaseBuild.replace(
    /\brelease\s*\{/,
    `release {
            if (hasCaptionStudioReleaseSigning) {
                signingConfig = signingConfigs.release
            }`,
  );
  const nextBuildTypes = replaceRange(buildTypes, releaseRange, releaseBuild);
  source = replaceRange(source, buildTypesRange, nextBuildTypes);
  source = source
    .replace(/^gradle\.taskGraph\.whenReady.*Caption Studio release signing credentials are missing.*\r?\n?/gm, '')
    .replace(/\ntasks\.configureEach \{ task ->\n\s*if \(task\.name\.toLowerCase\(\)\.contains\('release'\)\) \{[\s\S]*?\n\}\r?\n?$/m, '')
    .trimEnd();
  fs.writeFileSync(appBuild, `${source}\n\n${releaseSigningGuard}\n`);
}

if (require.main === module) configureAndroidRelease();

module.exports = { configureAndroidRelease };
