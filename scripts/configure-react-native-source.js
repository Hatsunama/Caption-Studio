const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const BEGIN = '// BEGIN CAPTION STUDIO RN 0.86.3 SOURCE BUILD';
const END = '// END CAPTION STUDIO RN 0.86.3 SOURCE BUILD';
const ANDROID = ':packages:react-native:ReactAndroid';
const HERMES = ANDROID + ':hermes-engine';

function block(eol) {
  return [
    '', BEGIN,
    "includeBuild('../node_modules/react-native') {",
    '    dependencySubstitution {',
    ...['react-android', 'react-native', 'hermes-android', 'hermes-engine'].map(name =>
      `        substitute(module("com.facebook.react:${name}")).using(project("${name.startsWith('hermes') ? HERMES : ANDROID}"))`),
    '    }', '}', END, '',
  ].join(eol);
}

// Check every ancestor, including junctions, before reading or writing paths.
function noLinks(file) {
  let current = path.resolve(file);
  while (true) {
    const stat = fs.lstatSync(current, { bigint: true });
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1n)) {
      throw new Error(`Refusing linked path: ${current}`);
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function stamp(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode, stat.nlink].join(':');
}

function read(file) {
  noLinks(file);
  const before = fs.lstatSync(file, { bigint: true });
  if (!before.isFile()) throw new Error(`Expected regular file: ${file}`);
  const bytes = fs.readFileSync(file);
  const after = fs.lstatSync(file, { bigint: true });
  if (stamp(before) !== stamp(after)) throw new Error(`Input changed while reading: ${file}`);
  // Keep the BOM and all original bytes; decoding is only for validation.
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  return { file, bytes, text, stamp: stamp(after), mode: Number(after.mode) };
}

function validateIncludes(text) {
  // Ignore ordinary comments, but leave quoted paths intact. Unknown includeBuild
  // expressions (including dynamic aliases) deliberately require manual review.
  const code = text.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g,
    token => token.startsWith('/') ? ' '.repeat(token.length) : token);
  const calls = [...code.matchAll(/\bincludeBuild\b/g)];
  for (const call of calls) {
    const rest = code.slice(call.index + call[0].length);
    const allowed = /^\s*\(\s*(?:reactNativeGradlePlugin|expoPluginsPath|expoAutolinking\.reactNativeGradlePlugin|['"]\.\.\/node_modules\/@react-native\/gradle-plugin['"])\s*\)/;
    if (!allowed.test(rest)) {
      throw new Error('Unknown or conflicting includeBuild outside the managed marker block');
    }
  }
}

function configureReactNativeSource(projectRoot) {
  const root = path.resolve(projectRoot);
  const settings = path.join(root, 'android/settings.gradle');
  noLinks(path.dirname(settings));
  const lock = settings + '.rn-source.lock';
  // Never remove a lock owned by another invocation; stale locks need review.
  const lockFd = fs.openSync(lock, 'wx', 0o600);
  let temporary;
  try {
    const inputs = [
      'package.json', 'node_modules/react-native/package.json',
      'node_modules/react-native/settings.gradle.kts', 'android/settings.gradle',
    ].map(name => read(path.join(root, name)));
    const [manifest, installed, source, current] = inputs;
    const json = input => JSON.parse(input.text.replace(/^\ufeff/, ''));
    // These gates run before the idempotent return, on every invocation.
    if (json(manifest).dependencies?.['react-native'] !== '0.86.3' || json(installed).version !== '0.86.3') {
      throw new Error('Source build requires exact root and installed React Native 0.86.3');
    }
    for (const project of [ANDROID, HERMES]) {
      if (!source.text.includes(`include("${project}")`)) {
        throw new Error(`Unknown React Native source settings: missing ${project}`);
      }
    }
    const eol = current.text.match(/\r?\n/)?.[0] || '\n';
    const managed = block(eol);
    let outside = current.text;
    const begins = current.text.split(BEGIN).length - 1;
    const ends = current.text.split(END).length - 1;
    if (begins || ends) {
      if (begins !== 1 || ends !== 1 || !current.text.endsWith(managed)) {
        throw new Error('Malformed, duplicate, or edited source build marker block');
      }
      outside = current.text.replace(managed, '');
    }
    validateIncludes(outside);
    if (begins) return false;

    const output = Buffer.concat([current.bytes, Buffer.from(managed)]);
    temporary = settings + `.rn-source-${randomUUID()}.tmp`;
    const fd = fs.openSync(temporary, 'wx', current.mode & 0o777);
    try {
      fs.writeFileSync(fd, output);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    // Atomic replacement plus optimistic concurrency check. The exclusive lock
    // serializes this helper; unrelated writers must not overlap prebuild/settings.
    for (const input of inputs) {
      const latest = read(input.file);
      if (latest.stamp !== input.stamp || !latest.bytes.equals(input.bytes)) {
        throw new Error(`Input changed before commit: ${input.file}`);
      }
    }
    noLinks(temporary);
    fs.renameSync(temporary, settings);
    temporary = undefined;
    return true;
  } finally {
    try {
      if (temporary) fs.unlinkSync(temporary);
    } finally {
      fs.closeSync(lockFd);
      fs.unlinkSync(lock);
    }
  }
}

module.exports = { configureReactNativeSource };

// After integration at scripts/configure-react-native-source.js, run this after
// clean Expo prebuild and the existing RN source backport step. No installs here.
if (require.main === module) {
  try {
    const changed = configureReactNativeSource(path.join(__dirname, '..'));
    console.log(changed ? 'Configured React Native 0.86.3 source build.' : 'React Native source build already configured.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
