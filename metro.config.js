const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
if (!config.resolver.assetExts.includes('txt')) config.resolver.assetExts.push('txt');

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'safe-buffer') {
    return context.resolveRequest(
      context,
      path.resolve(__dirname, 'src/shims/safe-buffer.ts'),
      platform,
    );
  }

  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
