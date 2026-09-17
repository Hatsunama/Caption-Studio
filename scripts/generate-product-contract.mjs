import { appendFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contractPath = path.join(root, 'config', 'product-contract.json');
const contract = JSON.parse(await readFile(contractPath, 'utf8'));
validate(contract);

const typescriptPath = path.join(root, 'modules', 'caption-translation', 'src', 'TranslationReleaseContract.generated.ts');
const javaPath = path.join(root, 'modules', 'caption-translation', 'android', 'src', 'main', 'java', 'app', 'captionstudio', 'translation', 'GeneratedProductContract.java');
const typescript = `export const TRANSLATION_RELEASE_CONTRACT = ${JSON.stringify(contract.translation, null, 2)} as const;\n`;
const java = `package app.captionstudio.translation;\n\nfinal class GeneratedProductContract {\n  static final long MODEL_BYTES = ${contract.translation.downloadBytes}L;\n  static final String MODEL_SHA256 = ${javaString(contract.translation.sha256)};\n  static final String MODEL_ID = ${javaString(contract.translation.id)};\n  static final String PROMPT_CONTRACT = ${javaString(contract.translation.promptContract)};\n\n  private GeneratedProductContract() {}\n}\n`;

if (process.argv.includes('--check')) {
  await requireExact(typescriptPath, typescript);
  await requireExact(javaPath, java);
} else {
  await Promise.all([
    writeFile(typescriptPath, typescript, 'utf8'),
    writeFile(javaPath, java, 'utf8'),
  ]);
}

if (process.argv.includes('--github-env')) {
  const destination = process.env.GITHUB_ENV;
  if (!destination) throw new Error('GITHUB_ENV is required for --github-env.');
  await appendFile(destination, [
    `CAPTION_STUDIO_SOURCE_PACKAGE=${contract.android.sourcePackage}`,
    `CAPTION_STUDIO_RELEASE_PACKAGE=${contract.android.release.package}`,
    `CAPTION_STUDIO_RELEASE_ASSET=${contract.android.release.assetName}`,
    `CAPTION_STUDIO_RELEASE_CERT_SHA256=${contract.android.release.signingCertificateSha256}`,
    '',
  ].join('\n'), 'utf8');
}

function validate(value) {
  if (value?.schemaVersion !== 1) throw new Error('Unsupported product contract version.');
  const release = value.android?.release;
  const translation = value.translation;
  for (const [label, candidate] of Object.entries({
    repository: value.repository,
    sourcePackage: value.android?.sourcePackage,
    releasePackage: release?.package,
    releaseAsset: release?.assetName,
    releaseCertificate: release?.signingCertificateSha256,
    modelId: translation?.id,
    modelSha256: translation?.sha256,
    promptContract: translation?.promptContract,
  })) {
    if (typeof candidate !== 'string' || !candidate.trim()) throw new Error(`Missing ${label}.`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(release.minimumVersion)) throw new Error('Invalid minimum release version.');
  if (!/^[a-f0-9]{64}$/.test(release.signingCertificateSha256)) throw new Error('Invalid release certificate digest.');
  if (!Number.isSafeInteger(translation.downloadBytes) || translation.downloadBytes < 1) throw new Error('Invalid model byte count.');
  if (!/^[a-f0-9]{64}$/.test(translation.sha256)) throw new Error('Invalid model digest.');
  if (!Number.isSafeInteger(translation.promptVersion) || translation.promptVersion < 1) throw new Error('Invalid prompt version.');
}

function javaString(value) {
  return JSON.stringify(value);
}

async function requireExact(file, expected) {
  const actual = await readFile(file, 'utf8').catch(() => '');
  if (actual !== expected) throw new Error(`${path.relative(root, file)} is stale. Run npm run generate:product-contract.`);
}
