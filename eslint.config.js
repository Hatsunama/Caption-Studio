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
      "src/components/editor/layer-timeline.tsx",
      "src/components/editor/video-tools.tsx",
      "src/components/editor/video-transform-overlay.tsx",
      "src/hooks/use-layer-gesture.ts",
    ],
    rules: {
      "react-hooks/refs": "off",
    },
  },
]);
