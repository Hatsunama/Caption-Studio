const { withAndroidStyles } = require('expo/config-plugins');

const SPLASH_STYLE = 'Theme.App.SplashScreen';
const BEHAVIOR_ITEM = 'android:windowSplashScreenBehavior';
const TOOLS_NAMESPACE = 'http://schemas.android.com/tools';

module.exports = function withSplashScreenApiContract(config) {
  return withAndroidStyles(config, (next) => {
    const resources = next.modResults.resources;
    const splashStyle = resources.style?.find((style) => style.$?.name === SPLASH_STYLE);
    if (!splashStyle) throw new Error(`${SPLASH_STYLE} was not generated`);

    const behavior = splashStyle.item?.find((item) => item.$?.name === BEHAVIOR_ITEM);
    if (!behavior) throw new Error(`${BEHAVIOR_ITEM} was not generated`);

    resources.$ = { ...resources.$, 'xmlns:tools': TOOLS_NAMESPACE };
    behavior.$ = { ...behavior.$, 'tools:targetApi': '33' };
    return next;
  });
};
