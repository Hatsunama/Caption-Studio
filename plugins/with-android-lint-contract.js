const { withAppBuildGradle } = require('expo/config-plugins');

const LINT_CONFIG_LINE = 'lintConfig = file("../../config/android-lint.xml")';

function withAndroidLintContract(config) {
  return withAppBuildGradle(config, (modConfig) => {
    if (modConfig.modResults.language !== 'groovy') {
      throw new Error('Caption Studio requires a Groovy Android app build file');
    }

    if (!modConfig.modResults.contents.includes(LINT_CONFIG_LINE)) {
      const androidBlock = /android\s*\{/;
      if (!androidBlock.test(modConfig.modResults.contents)) {
        throw new Error('Caption Studio could not locate the Android app build block');
      }
      modConfig.modResults.contents = modConfig.modResults.contents.replace(
        androidBlock,
        (match) => `${match}\n    lint {\n        ${LINT_CONFIG_LINE}\n    }`
      );
    }

    return modConfig;
  });
}

withAndroidLintContract.LINT_CONFIG_LINE = LINT_CONFIG_LINE;

module.exports = withAndroidLintContract;
