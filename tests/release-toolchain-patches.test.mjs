import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
const root = new URL('../', import.meta.url);
const json = name => JSON.parse(readFileSync(new URL(name, root), 'utf8'));
const manifest = json('package.json');
const lock = json('package-lock.json');
const workflows = readdirSync(new URL('.github/workflows/', root)).filter(name => /\.ya?ml$/.test(name)).map(name => [name, readFileSync(new URL('.github/workflows/' + name, root), 'utf8')]);
const protectedRuntimeDependencies = {
  "@react-native-community/slider": "5.2.0",
  "@react-navigation/native": "^7.3.18",
  "caption-diagnostics": "file:modules/caption-diagnostics",
  "caption-media": "file:modules/caption-media",
  "caption-translation": "file:modules/caption-translation",
  "expo": "57.0.31",
  "expo-asset": "57.0.20",
  "expo-audio": "~57.0.5",
  "expo-constants": "57.0.22",
  "expo-document-picker": "57.0.3",
  "expo-file-system": "~57.0.7",
  "expo-font": "~57.0.4",
  "expo-haptics": "~57.0.3",
  "expo-image": "~57.0.5",
  "expo-linking": "57.0.13",
  "expo-router": "57.0.29",
  "expo-sharing": "57.0.24",
  "expo-splash-screen": "57.0.10",
  "expo-sqlite": "57.0.4",
  "expo-status-bar": "~57.0.1",
  "expo-system-ui": "~57.0.4",
  "expo-video": "~57.0.5",
  "react": "19.2.3",
  "react-dom": "19.2.3",
  "react-native": "0.86.3",
  "react-native-gesture-handler": "~2.32.0",
  "react-native-reanimated": "4.5.1",
  "react-native-safe-area-context": "~5.7.0",
  "react-native-screens": "~4.26.0",
  "react-native-web": "~0.21.0",
  "react-native-worklets": "0.10.1",
  "whisper.rn": "^0.7.4"
};

test('security patch batch leaves every application dependency and the current model pinned', () => {
  assert.deepEqual(manifest.dependencies, protectedRuntimeDependencies);
  assert.deepEqual(lock.packages[''].dependencies, protectedRuntimeDependencies);
  const translation = json('config/product-contract.json').translation;
  assert.equal(translation.revision, '19edb84c69a0212f29a6ef17ba0d6f278b6a1614');
  assert.equal(translation.sha256, 'faa60663b333290c1496c499828b21d3e3254a788cacd8cce917ce0f761a2dc9');
});

test('approved safe npm patch versions are actually locked with integrity', () => {
  assert.equal(manifest.packageManager, 'npm@10.9.9');
  assert.equal(manifest.overrides.zod, '4.6.7');
  assert.equal(manifest.devDependencies.tsx, '4.23.15');
  for (const [name, version] of [['zod', '4.6.7'], ['tsx', '4.23.15']]) {
    assert.equal(lock.packages['node_modules/' + name].version, version);
    assert.match(lock.packages['node_modules/' + name].integrity, /^sha512-/);
  }
});

test('all configured Node jobs use the security patch and reviewed setup action', () => {
  const jobs = workflows.filter(([, source]) => source.includes('actions/setup-node@'));
  assert.ok(jobs.length >= 9);
  for (const [name, source] of jobs) {
    assert.doesNotMatch(source, /node-version: 22\.13\.1/, name);
    assert.match(source, /node-version: 22\.23\.4/, name);
    assert.match(source, /actions\/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1/, name);
  }
});

test('each Java setup audits both known JDKs before the next consuming step', () => {
  for (const [name, source] of workflows.filter(([, text]) => text.includes('actions/setup-java@'))) {
    assert.doesNotMatch(source, /actions\/setup-java@dd06d9cba3e5552c54d9f8ea23572deb30010f7c/, name);
    assert.match(source, /java-version: ['"]17\.0\.21\+9['"]/, name);
    assert.match(source, /java-version: ['"]21\.0\.13\+9['"]/, name);
    const setups = [...source.matchAll(/actions\/setup-java@/g)].length;
    const guards = [...source.matchAll(/run: node scripts\/harden-java-truststores\.mjs --ci/g)].length;
    assert.equal(setups, guards * 2, name + ' must guard each pair, including separate jobs');
    const blocks = source.split(/      - name: Harden and verify Java trust stores/).slice(1);
    for (const block of blocks) assert.match(block.split(/\n      - /)[0], /run: node scripts\/harden-java-truststores\.mjs --ci/, name);
  }
});

for (const [name, source] of workflows) {
  const steps = source.split(/(?=^      - )/m).filter(step => /^ {6}- uses: actions\/setup-java@|^ {8}uses: actions\/setup-java@/m.test(step));
  for (const [index, step] of steps.entries()) {
    test(`${name} Java setup ${index + 1} downloads a fresh signature-verified JDK`, () => {
      const inputs = step.match(/^ {8}with:\r?\n((?: {10}[^\r\n]*(?:\r?\n|$))*)/m)?.[1];
      assert.ok(inputs, 'Java setup must have its own with block');
      for (const input of ['force-download', 'verify-signature']) {
        assert.match(inputs, new RegExp(`^ {10}${input}: true[ \\t]*\\r?$`, 'm'), `${input} must be true in this Java setup's inputs`);
      }
      assert.match(inputs, /^ {10}cache-jdk: false[ \t]*\r?$/m, 'cache-jdk must be false in this Java setup\'s inputs');
    });
  }
}

test('release gates retain Expo doctor rather than suppressing compatibility checks', () => {
  for (const [name, source] of workflows.filter(([, text]) => text.includes('expo-doctor@'))) {
    assert.doesNotMatch(source, /expo-doctor@1\.20\.4/, name);
    assert.match(source, /expo-doctor@1\.21\.5/, name);
  }
});

test('unrelated locked packages retain every platform constraint and integrity field', async () => {
  const { createHash } = await import('node:crypto');
  const unchanged = Object.fromEntries(Object.entries(lock.packages).filter(([name]) => name && !['node_modules/tsx', 'node_modules/zod'].includes(name)));
  assert.equal(createHash('sha256').update(JSON.stringify(unchanged)).digest('hex'), '564741db7f8cac482384d93f3cd7a240d8643ded6c3e3b81b33d86e9914aaa19');
});
