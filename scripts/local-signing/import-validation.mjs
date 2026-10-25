// No dependencies, extraction API, cryptographic implementation, or pin overrides.
import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const RECIPIENT = '5be66294eff75a2c9aee7ca70d71b94c740113a768f26f46b6c75346cc72e6a4';
export const SIGNER = 'd02d23b28cbc615e3686d181aedefbbe5de993a0b6ba3f8e4ea2b6160211b35f';
export const FILES = ['keystore.p12', 'store-password.txt', 'key-password.txt', 'alias.txt'];
const sha = b => createHash('sha256').update(b).digest('hex');
const check = value => { if (!value) throw Error('Invalid recovery input'); };
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function exact(obj, expected) {
  check(obj && typeof obj === 'object' && !Array.isArray(obj));
  check(equal(Object.keys(obj).sort(), Object.keys(expected).sort()));
  for (const [k, v] of Object.entries(expected)) check(equal(obj[k], v));
}
export function validateManifest(m, ciphertext, approved, recipientHash) {
  check(/^[a-f0-9]{64}$/.test(approved) && recipientHash === RECIPIENT);
  const payload = { schema_version: 1, format: 'ZIP_STORED', files: FILES,
    keystore_encoding: 'original base64-decoded keystore bytes (JKS or PKCS#12)',
    text_encoding: 'UTF-8 without added newline', extra_entries_allowed: false, paths_allowed: false };
  exact(m?.payload, payload);
  check(typeof m?.openssl_version === 'string' && /^OpenSSL 3\.\d+\.\d+[^\r\n\0]*$/.test(m.openssl_version));
  exact(m, { schema_version: 1, envelope: 'CMS AuthEnvelopedData DER', content_encryption: 'AES-256-GCM',
    key_transport: 'RSA-OAEP', oaep_digest: 'SHA-256', mgf1_digest: 'SHA-256', openssl_version: m.openssl_version,
    exporter_sha256: approved, ciphertext_file: 'recovery.p7m', ciphertext_sha256: sha(ciphertext),
    recipient_certificate_der_sha256: RECIPIENT, expected_signing_certificate_der_sha256: SIGNER, payload: m.payload });
}

// Parse only DER framing/algorithm identifiers; OpenSSL performs all cryptography.
export function validateCms(bytes) {
  function node(offset, limit) {
    check(offset + 2 <= limit);
    const tag = bytes[offset++]; let len = bytes[offset++];
    if (len & 128) {
      const count = len & 127; check(count > 0 && count <= 3 && offset + count <= limit && bytes[offset] !== 0);
      len = 0; for (let i = 0; i < count; i++) len = len * 256 + bytes[offset++];
      check(len >= 128);
    }
    check(offset + len <= limit);
    const result = { tag, data: bytes.subarray(offset, offset + len), children: [], end: offset + len };
    if (tag & 32) { while (offset < result.end) { const c = node(offset, result.end); result.children.push(c); offset = c.end; } }
    return result;
  }
  const oid = (n, hex) => check(n?.tag === 6 && n.data.toString('hex') === hex);
  const seq = (n, count, tag = 48) => { check(n?.tag === tag && n.children.length === count); return n.children; };
  const sha256 = n => {
    check(n?.tag === 48 && [1, 2].includes(n.children.length));
    const c = n.children; oid(c[0], '608648016503040201');
    if (c.length === 2) check(c[1].tag === 5 && c[1].data.length === 0);
  };
  const root = node(0, bytes.length); check(root.end === bytes.length);
  const ci = seq(root, 2); oid(ci[0], '2a864886f70d0109100117');
  const env = seq(seq(ci[1], 1, 160)[0], 4);
  check(env[0].tag === 2 && env[0].data.equals(Buffer.from([0])));
  const recipient = seq(seq(env[1], 1, 49)[0], 4);
  check(recipient[0].tag === 2 && recipient[0].data.equals(Buffer.from([0])) && recipient[1].tag === 48 && recipient[3].tag === 4);
  const transport = seq(recipient[2], 2); oid(transport[0], '2a864886f70d010107');
  const params = seq(transport[1], 2);
  sha256(seq(params[0], 1, 160)[0]);
  const mgf = seq(seq(params[1], 1, 161)[0], 2); oid(mgf[0], '2a864886f70d010108'); sha256(mgf[1]);
  const content = seq(env[2], 3); oid(content[0], '2a864886f70d010701');
  const alg = seq(content[1], 2); oid(alg[0], '60864801650304012e');
  const gcm = seq(alg[1], 2); check(gcm[0].tag === 4 && gcm[0].data.length === 12);
  check(gcm[1].tag === 2 && gcm[1].data.equals(Buffer.from([16])));
  check(content[2].tag === 128 && content[2].data.length > 0 && env[3].tag === 4 && env[3].data.length === 16);
}

export function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
export function validateZip(b) {
  check(Buffer.isBuffer(b) && b.length >= 22 && b.length <= 540000);
  const end = b.length - 22;
  check(b.readUInt32LE(end) === 0x06054b50 && b.readUInt16LE(end + 4) === 0 && b.readUInt16LE(end + 6) === 0);
  check(b.readUInt16LE(end + 8) === 4 && b.readUInt16LE(end + 10) === 4 && b.readUInt16LE(end + 20) === 0);
  const directory = b.readUInt32LE(end + 16); check(directory + b.readUInt32LE(end + 12) === end);
  let c = directory, local = 0;
  const result = {};
  for (let i = 0; i < 4; i++) {
    check(c + 46 <= end && b.readUInt32LE(c) === 0x02014b50);
    const n = b.readUInt16LE(c + 28), size = b.readUInt32LE(c + 24), compressed = b.readUInt32LE(c + 20);
    check(c + 46 + n <= end && b.subarray(c + 46, c + 46 + n).equals(Buffer.from(FILES[i])));
    check(b.readUInt16LE(c + 4) === 0x0314 && b.readUInt16LE(c + 6) === 20);
    check(b.readUInt16LE(c + 8) === 0 && b.readUInt16LE(c + 10) === 0 && compressed === size);
    check(size > 0 && size <= (i ? 4096 : 524288));
    check(b.readUInt16LE(c + 30) === 0 && b.readUInt16LE(c + 32) === 0 && b.readUInt16LE(c + 34) === 0 && b.readUInt16LE(c + 36) === 0);
    check(b.readUInt32LE(c + 38) === ((0o100600 << 16) >>> 0) && b.readUInt32LE(c + 42) === local);
    check(local + 30 + n + size <= directory && b.readUInt32LE(local) === 0x04034b50);
    check(b.readUInt16LE(local + 4) === 20 && b.subarray(local + 6, local + 28).equals(b.subarray(c + 8, c + 30)));
    check(b.readUInt16LE(local + 28) === 0 && b.subarray(local + 30, local + 30 + n).equals(Buffer.from(FILES[i])));
    const data = b.subarray(local + 30 + n, local + 30 + n + size);
    check(crc32(data) === b.readUInt32LE(c + 16));
    if (i) { const s = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data); check(s.length > 0 && !/[\0\r\n]/.test(s)); }
    result[FILES[i]] = data;
    c += 46 + n; local += 30 + n + size;
  }
  check(c === end && local === directory);
  return result;
}
function bounded(path, max) { check(statSync(path).isFile() && statSync(path).size <= max); return readFileSync(path); }
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [mode, ...args] = process.argv.slice(2);
    if (mode === 'verify' && args.length === 4) {
      const [manifest, envelope, cert, approved] = args;
      const encrypted = bounded(envelope, 600000);
      const recipient = new X509Certificate(bounded(cert, 16384));
      validateManifest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bounded(manifest, 16384))), encrypted, approved, sha(recipient.raw));
      validateCms(encrypted);
    } else if (mode === 'unpack' && args.length === 2) {
      const payload = bounded(args[0], 540000);
      try {
        const members = validateZip(payload);
        for (const name of FILES) writeFileSync(join(args[1], name === 'keystore.p12' ? 'key.p12' : name), members[name], { flag: 'wx', mode: 0o600 });
      } finally { payload.fill(0); }
    } else throw Error();
  } catch { process.stderr.write('Recovery validation failed.\n'); process.exitCode = 1; }
}
