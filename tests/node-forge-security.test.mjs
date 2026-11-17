import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const rootRequire = createRequire(path.join(root, 'package.json'));
// Exercise the installed production graph, including each real consumer.
const forgeEntry = rootRequire.resolve('node-forge');
const forgeRequire = createRequire(forgeEntry);
const forge = rootRequire(forgeEntry);
console.log('FORGE_IMPLEMENTATION ' + forgeEntry);

test('Ed25519 rejects identity public key forgery for distinct messages (GHSA-6889-vf6x-f3g5)', () => {
  const publicKey = Buffer.alloc(32);
  publicKey[0] = 1; // Encoded identity point, order 1.
  const signature = Buffer.alloc(64);
  signature[0] = 1; // R = identity, S = 0; no private key required.
  for (const message of [Buffer.from('caption manifest'), Buffer.from('different manifest')]) {
    assert.equal(forge.ed25519.verify({ message, publicKey, signature }), false,
      'identity public key must not authenticate any message');
  }
});

test('Ed25519 authentic signatures pass and altered messages/signatures fail', () => {
  // Deterministic public test seed, used in memory only.
  const pair = forge.ed25519.generateKeyPair({ seed: Buffer.alloc(32, 42) });
  const message = Buffer.from('caption manifest');
  const signature = forge.ed25519.sign({ message, privateKey: pair.privateKey });
  assert.equal(forge.ed25519.verify({ message, publicKey: pair.publicKey, signature }), true);
  assert.equal(forge.ed25519.verify({ message: Buffer.from('different manifest'), publicKey: pair.publicKey, signature }), false);
  const altered = Buffer.from(signature);
  altered[32] ^= 1;
  assert.equal(forge.ed25519.verify({ message, publicKey: pair.publicKey, signature: altered }), false);
});

// Run the substantive committed upstream/backport RSA vectors unchanged, but
// resolve their implementation imports to the package under test. No Mocha
// install, workers, asynchronous key generation, or changed error expectations.
const rsaFile = path.join(root, 'vendor/reviewed-backports/node-forge/tests/unit/rsa.js');
const rsaSource = readFileSync(rsaFile, 'utf8');
const selectedSuites = new Set(['signature verification', 'GHSA-ppp5-5v6c-4jwp DigestInfo/padding checks']);
const stack = [];
let rsaCases = 0;
function describe(name, body) {
  if (name !== 'rsa' && !selectedSuites.has(name)) return;
  stack.push(name);
  try { body(); } finally { stack.pop(); }
}
function it(name, body) {
  if (!selectedSuites.has(stack.at(-1)) && !['should verify signature', 'should sign and verify'].includes(name)) return;
  assert.equal(body.length, 0, 'Selected RSA vectors must be synchronous');
  rsaCases++;
  test('existing RSA / ' + stack.join(' / ') + ' / ' + name, body);
}
function rsaRequire(specifier) {
  return specifier.startsWith('../../lib/')
    ? forgeRequire('./' + specifier.slice('../../lib/'.length))
    : rootRequire(specifier);
}
new Function('require', 'describe', 'it', rsaSource)(rsaRequire, describe, it);
assert.equal(rsaCases, 14, 'Retain all 12 signature security vectors and both RSA positive controls');

test('actual Expo certificate helper and CLI sign and verify fixture manifests', () => {
  const expoRequire = createRequire(rootRequire.resolve('expo/package.json'));
  const cliRequire = createRequire(expoRequire.resolve('@expo/cli/package.json'));
  const helperPath = cliRequire.resolve('@expo/code-signing-certificates');
  const helperRequire = createRequire(helperPath);
  for (const req of [cliRequire, helperRequire]) {
    assert.equal(req.resolve('node-forge'), forgeEntry, 'Expo consumers must resolve the tested forge');
  }
  const helper = cliRequire('@expo/code-signing-certificates');
  // Reuse the already-committed public upstream RSA fixture. Never access any
  // user signing material or write generated keys/certificates to disk.
  const fixture = rsaSource.match(/var _pem = (\{[\s\S]*?\n  \});/);
  assert.ok(fixture, 'Committed RSA PEM fixture must exist');
  const pem = new Function('return (' + fixture[1] + ');')();
  const pair = helper.convertKeyPairPEMToKeyPair({ privateKeyPEM: pem.privateKey, publicKeyPEM: pem.publicKey });
  const now = Date.now();
  const cert = helper.generateSelfSignedCodeSigningCertificate({
    keyPair: pair, validityNotBefore: new Date(now - 60000),
    validityNotAfter: new Date(now + 86400000), commonName: 'Public test fixture only',
  });
  const certificatePEM = helper.convertCertificateToCertificatePEM(cert);
  const parsed = helper.convertCertificatePEMToCertificate(certificatePEM);
  helper.validateSelfSignedCertificate(parsed, pair);
  assert.equal(parsed.verify(parsed), true);
  const csr = helper.generateCSR(pair, 'Public CSR fixture');
  assert.equal(helper.convertCSRPEMToCSR(helper.convertCSRToCSRPEM(csr)).verify(), true);
  const payload = Buffer.from('{"fixture":"caption manifest"}');
  const signature = helper.signBufferRSASHA256AndVerify(pair.privateKey, parsed, payload);
  const verify = (message, sig) => parsed.publicKey.verify(
    forge.md.sha256.create().update(message, 'utf8').digest().bytes(), forge.util.decode64(sig));
  assert.equal(verify(payload.toString('utf8'), signature), true);
  assert.equal(verify('altered manifest', signature), false);
  const { signManifestString } = cliRequire('./build/src/utils/codesigning.js');
  const cliSignature = signManifestString(payload.toString('utf8'), {
    privateKey: pem.privateKey, certificateForPrivateKey: certificatePEM,
  });
  assert.equal(verify(payload.toString('utf8'), cliSignature), true);
  assert.equal(verify('altered manifest', cliSignature), false);
  assert.throws(() => helper.convertCertificatePEMToCertificate('invalid certificate'));
  assert.throws(() => helper.convertCSRPEMToCSR('invalid CSR'));
});

test('existing dependency API success and rejection checks remain compatible', () => {
  rootRequire('./dependency-api-compatibility.cjs');
});
