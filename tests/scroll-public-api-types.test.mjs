import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

// Compile only the reusable public entry/consumer, without Expo's ambient
// declarations. This is a real native peer declaration graph, not device proof.
test('reusable scroll entry satisfies native consumers without Expo ambient types', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  for (const [name, version] of Object.entries({ react: '19.2.3', 'react-native': '0.86.3',
    'react-native-gesture-handler': '2.32.0', 'react-native-reanimated': '4.5.1', 'react-native-worklets': '0.10.1' })) {
    assert.equal(JSON.parse(readFileSync(path.join(root, 'node_modules', name, 'package.json'))).version, version, name);
  }
  const options = {
    noEmit: true, strict: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX, allowSyntheticDefaultImports: true,
    lib: ['lib.es2022.d.ts'], types: [],
  };
  const program = ts.createProgram([path.join(root, 'tests/types/scroll-public-api.tsx')], options);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => root, getCanonicalFileName: value => value, getNewLine: () => '\n',
  }));
});
