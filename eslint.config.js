const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ["dist/*", "scripts/*"],
    rules: {
      "react-hooks/refs": "error",
      "react-hooks/immutability": "error",
    },
  },
  {
    files: [
      "src/components/editor/caption-overlay.tsx",
      "src/components/editor/image-layer-overlay.tsx",
      "src/components/editor/layer-timeline.tsx",
      "src/components/editor/video-tools.tsx",
      "src/components/editor/video-transform-overlay.tsx",
    ],
    rules: {
      "react-hooks/refs": "off",
    },
  },
]);
