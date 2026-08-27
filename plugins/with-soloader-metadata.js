const { withAndroidManifest } = require('expo/config-plugins');

const SOLOADER_ENABLED = 'com.facebook.soloader.enabled';

module.exports = function withSoLoaderMetadata(config) {
  return withAndroidManifest(config, (next) => {
    const application = next.modResults.manifest.application?.[0];
    if (!application) throw new Error('Android application manifest is missing');
    const metadata = (application['meta-data'] ?? []).filter(
      (entry) => entry.$?.['android:name'] !== SOLOADER_ENABLED,
    );
    metadata.push({
      $: {
        'android:name': SOLOADER_ENABLED,
        'android:value': 'true',
        'tools:replace': 'android:value',
      },
    });
    application['meta-data'] = metadata;
    return next;
  });
};
