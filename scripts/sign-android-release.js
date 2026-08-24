const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
if (!process.argv.includes('--migration')) {
  throw new Error('This signer is only for the one-time debug-to-production migration APK. Pass --migration.');
}
const propertiesFile = path.join(os.homedir(), '.gradle', 'gradle.properties');
const properties = readProperties(propertiesFile);
const required = [
  'CAPTION_STUDIO_RELEASE_STORE_FILE',
  'CAPTION_STUDIO_RELEASE_STORE_PASSWORD',
  'CAPTION_STUDIO_RELEASE_KEY_ALIAS',
  'CAPTION_STUDIO_RELEASE_KEY_PASSWORD',
];
for (const name of required) {
  if (!properties[name]) throw new Error(`Missing ${name} in ${propertiesFile}`);
}

const androidHome = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
if (!androidHome) throw new Error('ANDROID_HOME or ANDROID_SDK_ROOT is required');
const buildTools = path.join(androidHome, 'build-tools');
const version = fs.readdirSync(buildTools).sort(compareVersions).at(-1);
if (!version) throw new Error(`No Android build-tools installation was found in ${buildTools}`);
const apksigner = path.join(buildTools, version, 'lib', 'apksigner.jar');
if (!fs.existsSync(apksigner)) throw new Error(`APK signer was not found: ${apksigner}`);
const javaHome = process.env.JAVA_HOME;
if (!javaHome) throw new Error('JAVA_HOME is required');
const java = path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
const apk = path.join(root, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
const signedApk = path.join(path.dirname(apk), 'app-release-migration.apk');
const lineage = path.join(root, 'signing', 'caption-studio-lineage.bin');
const previousKeystore = path.join(root, 'android', 'app', 'debug.keystore');
if (!fs.existsSync(apk)) throw new Error(`Release APK not found: ${apk}`);
if (!fs.existsSync(lineage)) throw new Error(`Signing lineage not found: ${lineage}`);

const environment = {
  ...process.env,
  CAPTION_STUDIO_PREVIOUS_PASSWORD: 'android',
  CAPTION_STUDIO_STORE_PASSWORD: properties.CAPTION_STUDIO_RELEASE_STORE_PASSWORD,
  CAPTION_STUDIO_KEY_PASSWORD: properties.CAPTION_STUDIO_RELEASE_KEY_PASSWORD,
};
const signerArguments = [
  '--ks', previousKeystore,
  '--ks-key-alias', 'androiddebugkey',
  '--ks-pass', 'env:CAPTION_STUDIO_PREVIOUS_PASSWORD',
  '--key-pass', 'env:CAPTION_STUDIO_PREVIOUS_PASSWORD',
  '--next-signer',
];
run(java, [
  '-jar', apksigner,
  'sign',
  ...signerArguments,
  '--ks', properties.CAPTION_STUDIO_RELEASE_STORE_FILE,
  '--ks-key-alias', properties.CAPTION_STUDIO_RELEASE_KEY_ALIAS,
  '--ks-pass', 'env:CAPTION_STUDIO_STORE_PASSWORD',
  '--key-pass', 'env:CAPTION_STUDIO_KEY_PASSWORD',
  '--lineage', lineage,
  '--rotation-min-sdk-version', '28',
  '--out', signedApk,
  apk,
], environment);
run(java, ['-jar', apksigner, 'verify', '--verbose', '--print-certs', signedApk], environment);

function readProperties(file) {
  if (!fs.existsSync(file)) throw new Error(`Signing properties not found: ${file}`);
  const entries = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line || line.trimStart().startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    entries.push([line.slice(0, separator).trim(), line.slice(separator + 1).trim()]);
  }
  return Object.fromEntries(entries);
}

function compareVersions(left, right) {
  return left.localeCompare(right, undefined, { numeric: true });
}

function run(command, args, env) {
  const result = spawnSync(command, args, { env, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `${path.basename(command)} failed`);
  if (result.stdout) process.stdout.write(result.stdout);
}
