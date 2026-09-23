const { withAndroidManifest } = require('@expo/config-plugins');

const GPU_LIBRARIES = ['libvndksupport.so', 'libOpenCL.so'];

module.exports = function withLiteRtGpuLibraries(config) {
  return withAndroidManifest(config, (mod) => {
    const application = mod.modResults.manifest.application?.[0];
    if (!application) {
      throw new Error('Android manifest has no application element');
    }
    const libraries = application['uses-native-library'] ?? [];
    const names = new Set(libraries.map((entry) => entry.$?.['android:name']));
    for (const name of GPU_LIBRARIES) {
      if (!names.has(name)) {
        libraries.push({ $: { 'android:name': name, 'android:required': 'false' } });
      }
    }
    application['uses-native-library'] = libraries;
    return mod;
  });
};
