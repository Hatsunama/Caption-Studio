'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');

async function main() {
  const out = path.join(process.env.RUNNER_TEMP, 'dependency-gate-audit');
  fs.mkdirSync(out, { recursive: true });
  const pkgRaw = fs.readFileSync('package.json');
  const lockRaw = fs.readFileSync('package-lock.json');
  const pkg = JSON.parse(pkgRaw);
  const lock = JSON.parse(lockRaw);
  const manifestHashes = Object.fromEntries([['package.json', pkgRaw], ['package-lock.json', lockRaw]]
    .map(([name, raw]) => [name, crypto.createHash('sha256').update(raw).digest('hex')]));
  const audit = spawnSync('npm', ['audit', '--omit=dev', '--audit-level=high'], { encoding: 'utf8', timeout: 120000 });
  fs.writeFileSync(path.join(out, 'audit.txt'), audit.stdout + audit.stderr);
  console.log(audit.stdout);
  console.log('AUDIT_EXIT', audit.status, audit.error?.message || '');
  const auditJson = spawnSync('npm', ['audit', '--omit=dev', '--audit-level=high', '--json'],
    { encoding: 'utf8', timeout: 120000 });
  fs.writeFileSync(path.join(out, 'audit.json'), auditJson.stdout);
  const report = JSON.parse(auditJson.stdout);
  const roots = Object.fromEntries(['braces', 'node-forge'].map(name =>
    [name, report.vulnerabilities?.[name]]));
  console.log('AUDIT_SUMMARY', JSON.stringify({ counts: report.metadata?.vulnerabilities, roots }));

  const semver = require('semver');
  const registry = {};
  for (const [name, bound] of [['braces', '3.0.3'], ['node-forge', '1.4.0']]) {
    const response = await fetch('https://registry.npmjs.org/' + name, { signal: AbortSignal.timeout(30000) });
    assert.equal(response.ok, true, 'Registry unavailable: ' + name);
    const data = await response.json();
    const versions = Object.keys(data.versions).filter(v => semver.valid(v)).sort(semver.compare);
    registry[name] = {
      source: response.url,
      fetchedAt: new Date().toISOString(),
      etag: response.headers.get('etag'),
      distTags: data['dist-tags'],
      highestStable: versions.filter(v => !semver.prerelease(v)).at(-1),
      versionsAboveAdvisoryBound: versions.filter(v => semver.gt(v, bound)),
      lockedVersion: lock.packages['node_modules/' + name].version,
      lockedIntegrity: lock.packages['node_modules/' + name].integrity,
      published: data.time?.[data['dist-tags'].latest]
    };
  }
  fs.writeFileSync(path.join(out, 'registry.json'), JSON.stringify(registry, null, 2));
  console.log('REGISTRY', JSON.stringify(registry));

  const results = [];
  const braces = require('braces');
  assert.deepEqual(braces.expand('src/{app,lib}/*.ts'), ['src/app/*.ts', 'src/lib/*.ts']);
  const micromatch = require('micromatch');
  assert.deepEqual(micromatch(['src/app/a.ts', 'src/lib/b.ts', 'src/other/c.ts'], 'src/{app,lib}/*.ts'),
    ['src/app/a.ts', 'src/lib/b.ts']);
  results.push({ name: 'ordinary brace expansion and file-map glob', passed: true });
  const nesting = 4900;
  const pattern = '{'.repeat(nesting) + 'a,b' + '}'.repeat(nesting);
  assert(pattern.length < 10000);
  for (const method of ['compile', 'expand']) {
    let error = null;
    try {
      if (method === 'compile') braces(pattern);
      else braces.expand(pattern, { rangeLimit: 100 });
    } catch (e) { error = { name: e.name, message: e.message }; }
    const stackOverflow = error?.name === 'RangeError' && /call stack/i.test(error.message);
    results.push({ name: 'deep braces ' + method, depth: nesting, inputLength: pattern.length,
      expected: 'bounded handling without stack exhaustion', passed: !stackOverflow, error });
  }

  const forge = require('node-forge');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pub = forge.pki.publicKeyFromPem(publicKey.export({ type: 'spki', format: 'pem' }));
  const digest = crypto.createHash('sha256').update('caption-studio dependency regression').digest();
  const valid = Buffer.concat([Buffer.from('3031300d060960864801650304020105000420', 'hex'), digest]);
  // Outer DigestInfo still has exactly two children. Only nested DigestAlgorithm has an extra child.
  const malformed = Buffer.concat([Buffer.from('303630120609608648016503040201050004036261640420', 'hex'), digest]);
  const signEncoded = encoded => crypto.privateEncrypt({ key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING },
    encoded).toString('binary');
  assert.equal(pub.verify(digest.toString('binary'), signEncoded(valid)), true);
  assert.equal(pub.verify(crypto.createHash('sha256').update('different message').digest().toString('binary'),
    signEncoded(valid)), false);
  results.push({ name: 'valid RSA signature and wrong-message control', passed: true });
  let accepted = false;
  let rejection = null;
  try { accepted = pub.verify(digest.toString('binary'), signEncoded(malformed)); }
  catch (e) { rejection = { name: e.name, message: e.message }; }
  results.push({ name: 'reject nested DigestAlgorithm extra child', passed: !accepted, accepted, rejection,
    limitation: 'Uses a generated private key to isolate malformed encoding acceptance; not a no-private-key forgery proof.' });
  fs.writeFileSync(path.join(out, 'behavior.json'), JSON.stringify(results, null, 2));
  console.log('BEHAVIOR', JSON.stringify(results));
  const summary = { baseline: 'cbb60fb58ed448f2146145ae2d2ccca2ec75dde1',
    srtHead: 'e3b8b9fe8d3f944c44996a7cb8e25de08c2c150c',
    harnessCommit: process.env.GITHUB_SHA, node: process.version,
    npm: spawnSync('npm', ['--version'], { encoding: 'utf8' }).stdout.trim(),
    manifestHashes, auditExit: audit.status, auditJsonExit: auditJson.status,
    counts: report.metadata?.vulnerabilities,
    compatiblePatchedReleaseEstablished: false, productionEdits: false,
    failedBehaviorChecks: results.filter(r => !r.passed).map(r => r.name) };
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log('SUMMARY', JSON.stringify(summary));
  process.exitCode = audit.status === 0 && results.every(r => r.passed) ? 0 : 1;
}
main().catch(error => { console.error(error); process.exitCode = 2; });
