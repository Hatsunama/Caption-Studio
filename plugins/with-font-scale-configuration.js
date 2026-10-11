const { withAndroidManifest } = require('expo/config-plugins');

// Handle only the observed fontScale recreation; Android still updates resources.
// https://developer.android.com/guide/topics/manifest/activity-element#config
// Expo SDK 57 forwards onConfigurationChanged and onResume to RN's delegate:
// https://github.com/expo/expo/blob/sdk-57/packages/expo/android/src/main/java/expo/modules/ReactActivityDelegateWrapper.kt
// RN 0.86.3 refreshes display metrics and requests layout on configuration change:
// https://github.com/facebook/react-native/blob/v0.86.3/packages/react-native/ReactAndroid/src/main/java/com/facebook/react/runtime/ReactHostImpl.kt
// DeviceInfoModule.onHostResume emits the changed fontScale to Dimensions;
// useWindowDimensions subscribes and compares fontScale as well as width/height.
// https://github.com/facebook/react-native/blob/v0.86.3/packages/react-native/ReactAndroid/src/main/java/com/facebook/react/modules/deviceinfo/DeviceInfoModule.kt
// https://github.com/facebook/react-native/blob/v0.86.3/packages/react-native/Libraries/Utilities/useWindowDimensions.js
module.exports = function withFontScaleConfiguration(config) {
  return withAndroidManifest(config, (next) => {
    // Match Expo's getMainActivity convention; never opt other activities out.
    const mainActivity = next.modResults.manifest.application?.[0]?.activity?.find(
      (activity) => activity.$?.['android:name'] === '.MainActivity',
    );
    if (!mainActivity) {
      throw new Error('with-font-scale-configuration: AndroidManifest.xml is missing Expo .MainActivity');
    }

    const existing = mainActivity.$['android:configChanges'] ?? '';
    if (!existing.split('|').some((flag) => flag.trim() === 'fontScale')) {
      mainActivity.$['android:configChanges'] = existing ? `${existing}|fontScale` : 'fontScale';
    }
    return next;
  });
};
