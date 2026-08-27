const { withAndroidManifest } = require('expo/config-plugins');

const WRITE_EXTERNAL_STORAGE = 'android.permission.WRITE_EXTERNAL_STORAGE';

module.exports = function withLegacyExportPermission(config) {
  return withAndroidManifest(config, (next) => {
    const manifest = next.modResults.manifest;
    const permissions = (manifest['uses-permission'] ?? []).filter(
      (permission) => permission.$?.['android:name'] !== WRITE_EXTERNAL_STORAGE,
    );
    permissions.push({
      $: {
        'android:name': WRITE_EXTERNAL_STORAGE,
        'android:maxSdkVersion': '28',
        'tools:replace': 'android:maxSdkVersion',
      },
    });
    manifest['uses-permission'] = permissions;
    return next;
  });
};
