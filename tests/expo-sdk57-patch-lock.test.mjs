import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
// Published SDK 57 patch floors from the 2026-10-21 Expo release.
const patchFloors = { expo: 31, 'expo-router': 29, 'expo-sharing': 24 };
const reviewedOverrides = {
  "@react-native/community-cli-plugin": {
    "metro": "0.84.5",
    "metro-config": "0.84.5"
  },
  "uuid": "11.1.1",
  "@xmldom/xmldom": "0.8.15",
  "query-string": "9.5.1",
  "shell-quote": "1.11.0",
  "source-map-js": "1.2.2",
  "braces": "https://raw.githubusercontent.com/Hatsunama/Caption-Studio/174efab75d927849e53ad58b0bc61b9487347c4b/vendor/reviewed-backports/caption-studio-braces-backport-3.0.3-caption-studio.1.tgz",
  "node-forge": "https://raw.githubusercontent.com/Hatsunama/Caption-Studio/174efab75d927849e53ad58b0bc61b9487347c4b/vendor/reviewed-backports/caption-studio-node-forge-backport-1.4.0-caption-studio.1.tgz"
};

for (const [name, floor] of Object.entries(patchFloors)) {
  test(name + ' is pinned and locked at the SDK 57 compatibility patch floor', () => {
    const version = manifest.dependencies[name];
    assert.match(version, /^57\.0\.\d+$/, name + ' must remain an exact stable SDK 57 pin');
    assert.ok(Number(version.split('.')[2]) >= floor, name + ' is below 57.0.' + floor);
    assert.equal(lock.packages[''].dependencies[name], version);
    const installed = lock.packages['node_modules/' + name];
    assert.equal(installed.version, version);
    assert.equal(installed.resolved, 'https://registry.npmjs.org/' + name + '/-/' + name + '-' + version + '.tgz');
    assert.match(installed.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
  });
}

test('manifest and lock root describe the same dependency graph', () => {
  assert.equal(lock.lockfileVersion, 3);
  for (const field of ['name', 'version', 'dependencies', 'devDependencies']) {
    assert.deepEqual(lock.packages[''][field], manifest[field], field);
  }
});

test('SDK 57 patch transitive minimums resolve in the actual lock graph', () => {
  for (const [name, floor] of Object.entries({ '@expo/cli': 32, '@expo/config-plugins': 11, 'expo-modules-core': 24, '@expo/ui': 26 })) {
    const entries = Object.entries(lock.packages).filter(([key]) => key.endsWith('/node_modules/' + name) || key === 'node_modules/' + name);
    assert.ok(entries.length > 0, name + ' must be locked');
    for (const [key, entry] of entries) {
      assert.match(entry.version, /^57\.0\.\d+$/, key);
      assert.ok(Number(entry.version.split('.')[2]) >= floor, key + ' is below 57.0.' + floor);
    }
  }
});

test('reviewed security overrides and platform pins survive the compatibility repair', () => {
  const releaseOverrides = { ...reviewedOverrides, zod: '4.6.6' };
  assert.deepEqual(manifest.overrides, releaseOverrides);
  for (const [name, version] of Object.entries({ react: '19.2.3', 'react-dom': '19.2.3', 'react-native': '0.86.3', 'react-native-reanimated': '4.5.1', 'react-native-worklets': '0.10.1' })) {
    assert.equal(manifest.dependencies[name], version, name);
    assert.equal(lock.packages['node_modules/' + name].version, version, name);
  }
  for (const [name, spec] of Object.entries(releaseOverrides)) {
    if (typeof spec !== 'string') continue;
    const entries = Object.entries(lock.packages).filter(([key]) => key.endsWith('/node_modules/' + name) || key === 'node_modules/' + name);
    // xcode 4 removes its uuid dependency; an unused override need not have a lock entry.
    if (entries.length === 0) {
      assert.equal(name, 'uuid', name + ' must remain locked');
      assert.ok(Object.values(lock.packages).every(entry => !entry.dependencies?.uuid && !entry.optionalDependencies?.uuid && !entry.peerDependencies?.uuid));
    }
    for (const [key, entry] of entries) {
      assert.equal(spec.startsWith('https:') ? entry.resolved : entry.version, spec, key);
    }
  }
  for (const name of ['metro', 'metro-config']) {
    const entries = Object.entries(lock.packages).filter(([key]) => key.endsWith('/node_modules/' + name) || key === 'node_modules/' + name);
    assert.ok(entries.some(([, entry]) => entry.version === reviewedOverrides['@react-native/community-cli-plugin'][name]), name + ' reviewed version must remain locked');
  }
});
