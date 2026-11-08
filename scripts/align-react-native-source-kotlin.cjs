const path = require('node:path');
const { createHash } = require('node:crypto');
const { readRequired, writeIfChanged } = require('./android-patch-utils');

const FROM = 'kotlin = "2.1.20"';
const TO = 'kotlin = "2.3.21"';
// Exact RN 0.86.3 catalog bytes: LF or CRLF, before and after this single edit.
// Keep hashes inline so integrating this helper needs no extra production files.
const APPROVED = [
  ['0fbabedc2b772460dea0f516f903a940026f7e35985eb7e257216732acd63e7e',
   'e2442b15cad2a71b2401cfda30718451c5362e2362ef82a4f0f9fc8a99c738ca'],
  ['7b99cc357d8a9219bd6b65d59cceda00d46c57138b70cf5a11f6469383f25100',
   'a2fd16f91b321aab1b90e5fb6012693c336329a4e496f6a71fd641cb17aef2f9'],
];
const sha256 = source => createHash('sha256').update(source).digest('hex');

// Opt in only from the private RN source-build workflow, after the existing
// product patches. Kotlin 2.3.20 fixes KT-83570 (Java annotation/Kotlin const IR);
// use the 2.3.21 patch. This helper does not enable a source build or run Gradle.
function alignReactNativeSourceKotlin(projectRoot, { sourceBuild = false } = {}) {
  if (sourceBuild !== true) throw new Error('Explicit source-build opt-in required.');
  const root = path.resolve(projectRoot);
  const manifest = JSON.parse(readRequired(path.join(root, 'package.json')));
  const installed = JSON.parse(readRequired(path.join(root, 'node_modules/react-native/package.json')));
  if (manifest.dependencies?.['react-native'] !== '0.86.3' ||
      installed.name !== 'react-native' || installed.version !== '0.86.3') {
    throw new Error('Requires exact root and installed React Native 0.86.3.');
  }
  const file = path.join(root, 'node_modules/react-native/gradle/libs.versions.toml');
  const source = readRequired(file);
  const hash = sha256(source);
  // All guards also run on the idempotent path; an unknown aligned file fails.
  if (APPROVED.some(([, after]) => hash === after)) return false;
  const pair = APPROVED.find(([before]) => hash === before);
  if (!pair) throw new Error('Unknown RN source Kotlin catalog SHA-256: ' + hash);
  const next = source.replace(FROM, TO);
  if (sha256(next) !== pair[1]) throw new Error('Unexpected RN source Kotlin alignment output.');
  return writeIfChanged(file, source, next);
}

module.exports = { alignReactNativeSourceKotlin };

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== '--source-build' || !args[1]) {
      throw new Error('Usage: node align-react-native-source-kotlin.cjs --source-build <project-root>');
    }
    const changed = alignReactNativeSourceKotlin(args[1], { sourceBuild: true });
    console.log(changed ? 'RN source Kotlin aligned to 2.3.21.' : 'RN source Kotlin already aligned to 2.3.21.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
