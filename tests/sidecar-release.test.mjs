import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  checkPublishedRelease, configureSidecarApp, releaseMetadataAsset,
  parseSigningCertificate, resolvePublishedRelease, validateReleaseMetadata,
} from '../scripts/configure-sidecar-release.mjs';

const root = new URL('../', import.meta.url);
const productContract = JSON.parse(readFileSync(fileURLToPath(new URL('config/product-contract.json', root)), 'utf8'));

test('APK signer parser accepts verified v2 and legacy output but rejects ambiguous identity', () => {
  const pinned = productContract.android.release.signingCertificateSha256;
  assert.equal(parseSigningCertificate(`Number of signers: 1\nV2 Signer: certificate SHA-256 digest: ${pinned}\n`, pinned), pinned);
  assert.equal(parseSigningCertificate(`Number of signers: 1\nSigner #1 certificate SHA-256 digest: ${pinned}\n`, pinned), pinned);
  assert.equal(parseSigningCertificate(`Number of signers: 1\nV2 Signer: certificate SHA-256 digest: ${pinned}\nV3 Signer: certificate SHA-256 digest: ${pinned}\n`, pinned), pinned);
  for (const output of [
    `Number of signers: 2\nV2 Signer: certificate SHA-256 digest: ${pinned}\n`,
    `Number of signers: 1\nV2 Signer: certificate SHA-256 digest: ${'0'.repeat(64)}\n`,
    `Number of signers: 1\nV2 Signer: certificate SHA-256 digest: ${pinned}\nV3 Signer: certificate SHA-256 digest: ${'0'.repeat(64)}\n`,
    `V2 Signer: certificate SHA-256 digest: ${pinned}\n`,
  ]) assert.throws(() => parseSigningCertificate(output, pinned));
});

test('release keeps the expected Android identity', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'caption-studio-sidecar-'));
  try {
    const configPath = path.join(directory, 'app.json');
    await writeFile(configPath, JSON.stringify({
      expo: {
        name: 'Caption Studio',
        slug: 'caption-studio',
        scheme: 'captionstudio',
        version: '1.4.2',
        android: { package: 'com.xmilo_at_your_side.caption_studio', versionCode: 14 },
      },
    }));
    const source = JSON.parse(readFileSync(configPath, 'utf8'));
    const configured = configureSidecarApp(source, '1.4.88', 100);
    assert.equal(configured.expo.name, 'Caption Studio');
    assert.equal(configured.expo.android.package, productContract.android.release.package);
    assert.equal(configured.expo.android.package, 'com.xmilo_at_your_side.caption_studio');
    assert.equal(configured.expo.android.versionCode, 100);
    assert.equal(configured.expo.version, '1.4.88');
    assert.equal(configured.expo.scheme, productContract.android.release.scheme);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('release rejects legacy package IDs', () => {
  for (const packageId of ['com.hatsunama.captionstudio', 'com.hatsunama.captionstudio.fixed']) {
    assert.throws(() => configureSidecarApp({ expo: { android: { package: packageId } } }, '1.4.88', 100),
      /unexpected Android package/);
  }
});

test('release workflow uses stable secrets and publishes a verified immutable APK', async () => {
  const workflow = await readFile(new URL('.github/workflows/publish-sidecar.yml', root), 'utf8');
  assert.match(workflow, /workflow_dispatch/);
  assert.match(workflow, /CAPTION_STUDIO_FIXED_KEYSTORE_BASE64/);
  assert.match(workflow, /CAPTION_STUDIO_RELEASE_PACKAGE/);
  assert.match(workflow, /CAPTION_STUDIO_RELEASE_CERT_SHA256/);
  assert.match(workflow, /apksigner verify --verbose --print-certs/);
  assert.match(workflow, /zipalign" -c -P 16 4/);
  assert.match(workflow, /gh release create/);
  assert.match(workflow, /tag="v\$\{VERSION\}"/);
  assert.match(workflow, /CAPTION_STUDIO_RELEASE_ASSET/);
  assert.match(workflow, /:app:lintRelease/);
  assert.match(workflow, /--write-metadata/);
  assert.match(workflow, /SIDECAR_BUILD_TOOLS/);
  assert.match(workflow, /"dist\/\$CAPTION_STUDIO_RELEASE_ASSET.sha256" \\\r?\n\s+dist\/caption-studio-release.json/);
  assert.match(workflow, /--init-script \.\.\/scripts\/first-party-android-lint\.gradle/);
  assert.doesNotMatch(workflow, /Caption Studio Fixed/);
  assert.doesNotMatch(workflow, /v\$\{VERSION\}-fixed/);
  assert.doesNotMatch(workflow, /caption-studio-fixed-android/);
  assert.doesNotMatch(workflow, /keytool -genkeypair/);
});

function metadata(overrides = {}) {
  return {
    schemaVersion: 1, repository: productContract.repository, tag: 'v1.4.86',
    version: '1.4.86', versionCode: 98, sourceCommit: 'a'.repeat(40),
    package: productContract.android.release.package,
    signingCertificateSha256: productContract.android.release.signingCertificateSha256,
    apk: { name: productContract.android.release.assetName, sha256: 'b'.repeat(64) },
    ...overrides,
  };
}

function published(withMetadata = true) {
  return {
    tag_name: 'v1.4.86', draft: false, prerelease: true, published_at: '2026-09-01T00:00:00Z',
    assets: [
      { name: productContract.android.release.assetName, digest: `sha256:${'b'.repeat(64)}` },
      ...(withMetadata ? [{ name: releaseMetadataAsset, id: 123, size: 600 }] : []),
    ],
  };
}

test('authoritative manifest supplies checkout-only versionCode without consulting tagged config or APK', async () => {
  const result = await resolvePublishedRelease(published(), {
    readMetadata: async () => metadata({ versionCode: 123 }),
    readLegacy: async () => assert.fail('Manifest must avoid APK download'),
  });
  assert.deepEqual(result, { tag: 'v1.4.86', versionCode: 123 });
});

test('metadata rejects wrong provenance, identity, ordering fields and digest', () => {
  for (const overrides of [
    { schemaVersion: 2 }, { repository: 'other/repo' }, { tag: 'v1.4.85' },
    { version: '1.4.85' }, { versionCode: 0 }, { versionCode: 2100000001 },
    { versionCode: '98' }, { sourceCommit: '' }, { package: 'com.hatsunama.captionstudio' },
    { signingCertificateSha256: '0'.repeat(64) },
    { apk: { name: 'other.apk', sha256: 'b'.repeat(64) } },
    { apk: { name: productContract.android.release.assetName, sha256: 'c'.repeat(64) } },
  ]) {
    assert.throws(() => validateReleaseMetadata(metadata(overrides), 'v1.4.86', published().assets[0]));
  }
});

test('invalid or unavailable manifest fails closed without a legacy fallback', async () => {
  for (const readMetadata of [async () => metadata({ version: '1.0.0' }),
    async () => { throw new Error('API failure'); }]) {
    await assert.rejects(resolvePublishedRelease(published(), {
      readMetadata, readLegacy: async () => assert.fail('Must not fall back'),
    }));
  }
});

test('historical releases use actual APK identity and exclude only known old packages', async () => {
  const release = published(false);
  const resolve = (identity) => resolvePublishedRelease(release, { readLegacy: async () => identity });
  assert.deepEqual(await resolve(metadata({ versionCode: 123 })), { tag: 'v1.4.86', versionCode: 123 });
  for (const packageId of ['com.hatsunama.captionstudio', 'com.hatsunama.captionstudio.fixed']) {
    assert.equal(await resolve(metadata({ package: packageId })), null);
  }
  for (const overrides of [{ package: 'unknown.package' }, { version: '1.4.85' },
    { signingCertificateSha256: '0'.repeat(64) }, { versionCode: 0 }]) {
    await assert.rejects(resolve(metadata(overrides)));
  }
  await assert.rejects(resolvePublishedRelease(release, {
    readLegacy: async () => { throw new Error('APK unavailable'); },
  }), /APK unavailable/);
});

test('ordering includes this package lineage, prereleases, and draft tag collisions', async () => {
  const releases = [{ ...published(), tag_name: 'v1.4.88' },
    { ...published(false), tag_name: 'v1.4.86' }];
  const resolvedTags = [];
  const options = {
    listReleases: async () => releases,
    resolveRelease: async (release) => {
      resolvedTags.push(release.tag_name);
      return { tag: release.tag_name, versionCode: 150 };
    },
  };
  await assert.rejects(checkPublishedRelease('1.4.89', 150, options), /must exceed.*150/);
  await checkPublishedRelease('1.4.89', 151, options);
  assert.deepEqual([...new Set(resolvedTags)], ['v1.4.88']);
  await assert.rejects(checkPublishedRelease('1.4.87', 151, options), /must be at least/);
  await assert.rejects(checkPublishedRelease('1.4.88', 151, options), /already exists/);
  releases.push({ ...published(), tag_name: 'v1.4.89', draft: true });
  await assert.rejects(checkPublishedRelease('1.4.89', 151, options), /already exists/);
  await assert.rejects(checkPublishedRelease('1.4.90', 151, {
    listReleases: async () => { throw new Error('API failure'); },
  }), /API failure/);
});

test('verification workflow runs Android lint before retaining release artifacts', async () => {
  const workflow = await readFile(new URL('.github/workflows/ci.yml', root), 'utf8');
  assert.match(workflow, /:app:lintRelease/);
  assert.match(workflow, /--init-script \.\.\/scripts\/first-party-android-lint\.gradle/);
  assert.match(workflow, /:app:assembleRelease/);
  assert.match(workflow, /:app:bundleRelease/);
});

test('installer is fail-closed and cannot delete the production app', async () => {
  const installer = await readFile(new URL('scripts/install-caption-studio.ps1', root), 'utf8');
  assert.match(installer, /config\/product-contract\.json/);
  assert.match(installer, /signingCertificateSha256/);
  assert.match(installer, /Get-ApkCertificateSha256/);
  assert.ok(installer.includes("$Package -cne 'com.xmilo_at_your_side.caption_studio'"));
  assert.ok(installer.includes("[string]$Contract.android.sourcePackage -cne 'com.xmilo_at_your_side.caption_studio'"));
  assert.ok(installer.includes('$ActualPackage -cne $Package'));
  assert.ok(installer.includes('APK package mismatch:'));
  const packageCheck = installer.indexOf('$ActualPackage = Get-ApkPackage');
  const installCommand = installer.indexOf("$InstallOutput = @(Invoke-Adb @('-s', $Serial, 'install'");
  assert.ok(packageCheck >= 0 && installCommand > packageCheck);
  assert.ok(installer.includes('-ExpectedVersion $ReleaseVersionText'));
  assert.ok(installer.includes('$VersionMatch.Groups[2].Value -cne $ExpectedVersion'));
  assert.ok(installer.includes('$VersionMatch.Groups[2].Value -cnotmatch $VersionPattern'));
  assert.ok(installer.includes('[long]$VersionMatch.Groups[1].Value -gt 2100000000'));
  assert.ok(installer.includes('APK version metadata is missing or invalid. Refusing installation.'));
  assert.match(installer, /apksigner/);
  assert.match(installer, /Multiple Android devices are connected/);
  assert.match(installer, /device\|unauthorized\|offline/);
  assert.match(installer, /function Get-FileSha256/);
  assert.match(installer, /Get-Command Get-FileHash/);
  assert.match(installer, /\[Security\.Cryptography\.SHA256\]::Create\(\)/);
  assert.match(installer, /'install', '-r', '--no-streaming'/);
  assert.match(installer, /\$Package = \[string\]\$Contract\.android\.release\.package/);
  assert.doesNotMatch(installer, /['"](?:uninstall|clear)['"]/);
  assert.doesNotMatch(installer, /com\.hatsunama\.captionstudio(?:\.fixed)?(?:['"]|\s)/);
});
